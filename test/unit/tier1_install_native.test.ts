/**
 * Tier-1 backlog gate — the install subsystem's PURE helpers (coverage plan
 * §4.1.9): the pg-client candidate ORDER and the vendored hierarchy-descriptor
 * readers. The destructive install orchestration around them stays exempt
 * (§5.2) — this file executes none of it. (Its address-allowlist family left
 * with the pre-auth install surface, 2026-10-12 —
 * WC-2026-10-12-install-surface-removed; the grammar itself was retired
 * 2026-11-19 with its last consumer, the error-report intake.)
 *
 * Operator-visible failure each family prevents:
 *  - pgBinaryCandidates: a client OLDER than the server refuses to connect, so
 *    "newest first" and "configured dir wins" are the difference between a
 *    working backup/restore and an install that dies at the psql step.
 *  - hierarchy_meta: the installer's thesaurus list and the activator read the SAME
 *    vendored manifest (hierarchy.json); a reader that fails soft on a missing
 *    manifest ships an install that silently offers no thesaurus, one that
 *    offers a core tld ships an import of terms the seed already carries.
 *
 * Pure: no DB, no server.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	CORE_HIERARCHIES,
	hierarchyChoiceView,
	hierarchyMetaByTld,
	isCoreHierarchyTld,
	labelCollator,
	offeredHierarchies,
	readHierarchyManifest,
} from '../../src/core/install/hierarchy_meta.ts';
import { deriveLangConfig } from '../../src/core/install/lang_catalog.ts';
import { pgBinaryCandidates } from '../../src/core/install/pg_bin.ts';

describe('pgBinaryCandidates — probe ORDER (§4.1.9)', () => {
	test('the configured dir is probed FIRST, then Homebrew newest-first', () => {
		expect(pgBinaryCandidates('psql', '/opt/pg/bin')).toEqual([
			'/opt/pg/bin/psql',
			'/opt/homebrew/opt/postgresql@18/bin/psql',
			'/opt/homebrew/opt/postgresql@17/bin/psql',
			'/opt/homebrew/opt/postgresql@16/bin/psql',
			'/opt/homebrew/opt/postgresql@15/bin/psql',
		]);
	});

	test('no configured dir (undefined or empty) contributes no candidate', () => {
		const expected = [18, 17, 16, 15].map((v) => `/opt/homebrew/opt/postgresql@${v}/bin/pg_dump`);
		expect(pgBinaryCandidates('pg_dump', undefined)).toEqual(expected);
		expect(pgBinaryCandidates('pg_dump', '')).toEqual(expected);
	});
});

describe('hierarchy_meta — the vendored thesaurus manifest reader (§4.1.9)', () => {
	test('a MISSING manifest is refused (install.manifest_invalid), never an empty offer', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-hierarchy-meta-'));
		try {
			let refusal: unknown = null;
			try {
				readHierarchyManifest(dir);
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toBeInstanceOf(DedaloError);
			expect((refusal as DedaloError).code).toBe('install.manifest_invalid');
			expect((refusal as DedaloError).publicMessage).toContain('hierarchy.json: missing');
			// The public sentence never names the server path.
			expect((refusal as DedaloError).publicMessage).not.toContain(dir);
			expect(() => offeredHierarchies(dir)).toThrow(DedaloError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('offeredHierarchies = every NON-CORE entry, with or without data files', () => {
		const manifest = readHierarchyManifest();
		const offered = offeredHierarchies();
		expect(offered.length).toBeGreaterThan(0);
		expect(offered.map((entry) => entry.tld)).toEqual(
			manifest.active_hierarchies
				.filter((entry) => !isCoreHierarchyTld(entry.tld))
				.map((entry) => entry.tld),
		);
	});

	test('hierarchyMetaByTld normalizes case and whitespace; an unknown tld is null', () => {
		const found = hierarchyMetaByTld('  AF  ');
		expect(found?.tld).toBe('af');
		expect(typeof found?.name).toBe('string');
		expect(Number.isInteger(found?.lang.section_id)).toBe(true);
		expect(hierarchyMetaByTld('zzbk')).toBeNull();
	});

	test('a vendored entry lists its own data file by NAME (a file name, never a bare tld)', () => {
		// `ad` = the smallest vendored thesaurus (also install_hierarchy_tools' subject).
		const files = hierarchyMetaByTld('ad')?.data_files ?? [];
		expect(files.map((item) => item.file)).toEqual(['ad1.copy.gz']);
		expect(files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test('the client view is {tld,label,typology,has_data,dependencies} / {typology,label}, derived from the manifest', () => {
		const view = hierarchyChoiceView('lg-eng');
		const offered = offeredHierarchies();
		expect(view.hierarchies.length).toBeGreaterThan(0);
		expect(view.hierarchies).toHaveLength(offered.length);
		// SAME SET as the offer (no entry lost, none invented, none twice)…
		const offeredByTld = new Map(offered.map((entry) => [entry.tld, entry]));
		expect(view.hierarchies.map((item) => item.tld).sort()).toEqual(
			[...offeredByTld.keys()].sort(),
		);
		// …in the READER'S order: by label in its collation, tld breaking a tie — never the
		// manifest's storage order (cee1a3ea20; full contract: hierarchy_choice_order.test.ts).
		const collator = labelCollator('lg-eng');
		expect(view.hierarchies.map((item) => item.tld)).toEqual(
			[...view.hierarchies]
				.sort((a, b) => collator.compare(a.label, b.label) || a.tld.localeCompare(b.tld))
				.map((item) => item.tld),
		);
		// Each entry derived from ITS manifest entry, paired by tld (not by position).
		for (const item of view.hierarchies) {
			const entry = offeredByTld.get(item.tld);
			if (entry === undefined) throw new Error(`view entry '${item.tld}' is not offered`);
			expect(item).toEqual({
				tld: entry.tld,
				label: expect.any(String),
				typology: entry.typology_id,
				has_data: entry.data_files.length > 0,
				// the declared THESAURI only (core excluded) — the client pre-ticks them
				dependencies: (entry.dependencies ?? [])
					.filter((item) => item.main === 'hierarchy1' && item.tld !== 'lg')
					.map((item) => ({ tld: item.tld, mandatory: item.mandatory })),
			});
		}
		expect(view.hierarchy_typologies.length).toBeGreaterThan(0);
		expect(view.hierarchy_typologies.map((item) => item.typology).sort((a, b) => a - b)).toEqual(
			readHierarchyManifest()
				.typologies.map((item) => item.typology_id)
				.sort((a, b) => a - b),
		);
		for (const item of view.hierarchy_typologies) {
			expect(Object.keys(item).sort()).toEqual(['label', 'typology']);
		}
	});

	test("labels are picked in the READER's language from name_data, never frozen in the exporter's", () => {
		// The exporter picked `name` in ITS application language (here: Spanish).
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-hierarchy-view-'));
		try {
			const spa = (value: string) => ({ id: 1, lang: 'lg-spa', value });
			const eng = (value: string) => ({ id: 1, lang: 'lg-eng', value });
			const entry = (tld: string, name: string, nameData: unknown[], dependencies?: unknown[]) => ({
				tld,
				name,
				name_data: nameData,
				typology_id: 2,
				typology_name: 'Toponimia',
				lang: { section_id: 17344, label: null },
				real_section_tipo: null,
				active_in_thesaurus: true,
				scope_note_data: [],
				data_files: [],
				...(dependencies === undefined ? {} : { dependencies }),
			});
			writeFileSync(
				join(dir, 'hierarchy.json'),
				JSON.stringify({
					version: 'scratch',
					date: 'scratch',
					entity_id: null,
					entity: null,
					entity_label: null,
					host: null,
					typologies: [
						{ typology_id: 2, name: 'Toponimia', name_data: [spa('Toponimia'), eng('Toponymy')] },
					],
					active_hierarchies: [
						// zza declares thesauri (one mandatory, one optional), a core one and an ontology
						entry(
							'zza',
							'Afganistán',
							[spa('Afganistán'), eng('Afghanistan')],
							[
								{ tld: 'zzb', main: 'hierarchy1', mandatory: true },
								{ tld: 'zzch', main: 'hierarchy1', mandatory: false },
								{ tld: 'lg', main: 'hierarchy1', mandatory: true },
								{ tld: 'zzonto', main: 'ontology35', mandatory: true },
							],
						),
						// Only a Spanish item: the any-language fallback, never the tld.
						entry('zzb', 'Bután', [spa('Bután')]),
						// No item at all: the export-time name, then the tld.
						entry('zzch', 'Chad', []),
					],
				}),
			);
			const english = hierarchyChoiceView('lg-eng', dir);
			expect(english.hierarchies.map((item) => item.label)).toEqual([
				'Afghanistan',
				'Bután',
				'Chad',
			]);
			expect(english.hierarchy_typologies).toEqual([{ typology: 2, label: 'Toponymy' }]);
			// the view carries ONLY the declared non-core THESAURI (what the client pre-ticks)
			expect(english.hierarchies.map((item) => [item.tld, item.dependencies])).toEqual([
				[
					'zza',
					[
						{ tld: 'zzb', mandatory: true },
						{ tld: 'zzch', mandatory: false },
					],
				],
				['zzb', []],
				['zzch', []],
			]);
			const spanish = hierarchyChoiceView('lg-spa', dir);
			expect(spanish.hierarchies.map((item) => item.label)).toEqual([
				'Afganistán',
				'Bután',
				'Chad',
			]);
			expect(spanish.hierarchy_typologies).toEqual([{ typology: 2, label: 'Toponimia' }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a CORE hierarchy (lg) is described by the engine, never offered as a choice', () => {
		// lg is activated by the seed restore against the terms the seed ships in
		// matrix_langs (A7, 2026-10-08): the activator must describe it, the
		// installer must never offer or import it.
		expect(CORE_HIERARCHIES.length).toBeGreaterThan(0);
		expect(isCoreHierarchyTld('  LG ')).toBe(true);
		expect(isCoreHierarchyTld('af')).toBe(false);
		expect(CORE_HIERARCHIES).toEqual([
			{ tld: 'lg', label: 'Languages', active_in_thesaurus: true },
		]);
		// The manifest lists lg as METADATA only (never a data file).
		expect(hierarchyMetaByTld('Lg')?.data_files).toEqual([]);
		const offered = new Set(offeredHierarchies().map((meta) => meta.tld));
		const viewed = new Set(hierarchyChoiceView('lg-eng').hierarchies.map((item) => item.tld));
		for (const core of CORE_HIERARCHIES) {
			expect(offered.has(core.tld)).toBe(false);
			expect(viewed.has(core.tld)).toBe(false);
		}
	});
});

describe('deriveLangConfig — the remaining default branch (§4.1.9)', () => {
	test('an EMPTY-STRING default falls back to the first picked code without an error', () => {
		const derived = deriveLangConfig({
			langs: ['lg-cat', 'lg-eng'],
			appLangDefault: '',
			dataLangDefault: '',
		});
		expect(derived.applicationLangsDefault).toBe('lg-cat');
		expect(derived.dataLangDefault).toBe('lg-cat');
		expect(derived.errors).toEqual([]);
		expect(derived.structureLang).toBe('lg-spa');
	});
});
