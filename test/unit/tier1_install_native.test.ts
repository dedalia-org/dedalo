/**
 * Tier-1 backlog gate — the install subsystem's PURE helpers (coverage plan
 * §4.1.9): the pre-auth IP allow-list, the pg-client candidate ORDER, and the
 * vendored hierarchy-descriptor readers. The destructive install orchestration
 * around them stays exempt (§5.2) — this file executes none of it.
 *
 * Operator-visible failure each family prevents:
 *  - installIpAllowed: it is the ONLY address check in front of an
 *    UNAUTHENTICATED installer that rewrites ../private/.env and spawns psql.
 *    A regression that widens it exposes that surface; one that narrows the
 *    `loopback` token locks the operator out of their own fresh box. The
 *    DEFAULT half of that contract (unset ⇒ loopback only, fail-closed since
 *    2026-08-24) plus the CIDR grammar are pinned by
 *    test/unit/install_ip_gate_tripwire.test.ts; what stays here is the
 *    per-entry matching behaviour this tier already owned.
 *  - pgBinaryCandidates: a client OLDER than the server refuses to connect, so
 *    "newest first" and "configured dir wins" are the difference between a
 *    working backup/restore and an install that dies at the psql step.
 *  - hierarchy_meta: the wizard's checkbox list and the activator read the SAME
 *    vendored manifest (hierarchy.json); a reader that fails soft on a missing
 *    manifest ships an install that silently offers no thesaurus, one that
 *    offers a core tld ships an import of terms the seed already carries.
 *
 * Pure: no DB, no server. `DEDALO_INSTALL_ALLOWED_IPS` is set/cleared on
 * process.env (readEnv resolves per call and process env wins) and restored.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnv } from '../../src/config/env.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { installIpAllowed } from '../../src/core/install/gate.ts';
import {
	CORE_HIERARCHIES,
	hierarchyChoiceView,
	hierarchyMetaByTld,
	isCoreHierarchyTld,
	offeredHierarchies,
	readHierarchyManifest,
} from '../../src/core/install/hierarchy_meta.ts';
import { deriveLangConfig } from '../../src/core/install/lang_catalog.ts';
import { pgBinaryCandidates } from '../../src/core/install/pg_bin.ts';

const KEY = 'DEDALO_INSTALL_ALLOWED_IPS';
const original = process.env[KEY];

afterEach(() => {
	if (original === undefined) delete process.env[KEY];
	else process.env[KEY] = original;
});

describe('installIpAllowed — the pre-auth install surface address gate (§4.1.9)', () => {
	// INVERTED 2026-08-24 (audit P2-6,
	// engineering/wire_contract/WC-2026-08-24-install-ip-gate-fail-closed.md):
	// these two cases used to assert that an unset/empty key left the surface
	// OPEN. It is now LOOPBACK ONLY — the operator opts out explicitly with `any`.
	test('an EMPTY / whitespace value is the DEFAULT, not "open"', () => {
		process.env[KEY] = '';
		expect(installIpAllowed('203.0.113.7')).toBe(false);
		expect(installIpAllowed('127.0.0.1')).toBe(true);
		process.env[KEY] = '   ';
		expect(installIpAllowed('203.0.113.7')).toBe(false);
		// A value of nothing but separators is still "the operator said nothing".
		process.env[KEY] = ' , , ';
		expect(installIpAllowed('203.0.113.7')).toBe(false);
		expect(installIpAllowed('local')).toBe(true);
	});

	test('UNSET is LOOPBACK ONLY — the unauthenticated installer is not exposed', () => {
		delete process.env[KEY];
		// Only meaningful when this checkout's ../private/.env does not set the key.
		if (readEnv(KEY) === undefined) {
			expect(installIpAllowed('203.0.113.7')).toBe(false);
			expect(installIpAllowed('local')).toBe(true);
		}
	});

	test("the 'loopback' token matches EVERY local spelling and nothing else", () => {
		process.env[KEY] = 'loopback';
		for (const ip of ['local', '127.0.0.1', '::1', '::ffff:127.0.0.1']) {
			expect(installIpAllowed(ip)).toBe(true);
		}
		expect(installIpAllowed('127.0.0.2')).toBe(false);
		expect(installIpAllowed('203.0.113.7')).toBe(false);
	});

	test('a set list admits only its exact entries — everything else is refused', () => {
		process.env[KEY] = ' 10.0.0.5 , , 192.168.1.9 ';
		expect(installIpAllowed('10.0.0.5')).toBe(true);
		expect(installIpAllowed('192.168.1.9')).toBe(true);
		expect(installIpAllowed('10.0.0.50')).toBe(false);
		expect(installIpAllowed('local')).toBe(false); // no loopback token ⇒ no implicit local
		expect(installIpAllowed('')).toBe(false); // an empty entry never becomes a wildcard
	});
});

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
		for (const [index, entry] of offered.entries()) {
			expect(view.hierarchies[index]).toEqual({
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
								{ tld: 'zzc', main: 'hierarchy1', mandatory: false },
								{ tld: 'lg', main: 'hierarchy1', mandatory: true },
								{ tld: 'zzonto', main: 'ontology35', mandatory: true },
							],
						),
						// Only a Spanish item: the any-language fallback, never the tld.
						entry('zzb', 'Bután', [spa('Bután')]),
						// No item at all: the export-time name, then the tld.
						entry('zzc', 'Chad', []),
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
						{ tld: 'zzc', mandatory: false },
					],
				],
				['zzb', []],
				['zzc', []],
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
		// wizard/CLI must never offer or import it.
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
