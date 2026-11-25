/**
 * RELEASE-ONTOLOGY PRECONDITIONS — what the VENDORED ontology release
 * (install/import/ontology/<release>/, read off disk by
 * test/helpers/release_ontology.ts) must carry for engine behaviour that
 * leans on it. These are the mechanical form of two former owner holds:
 *
 *  - T2-RC-3 / M2: an implicit component whose relations name no section
 *    targets the CALLER's section (implicit.ts). dd170
 *    (component_filter_master) used to relate only dd156, so RC-3 would have
 *    retargeted it to the users section; the release must relate it to dd153.
 *    WC-2026-11-25-implicit-component-target-caller-section.
 *  - T2-THES-04 / M4: the tree's "+" writes no is_descriptor / is_indexable
 *    value of its own — the record-birth seed applies the flag component's
 *    `dato_default` (WC-2026-08-09-record-birth-defaults, addendum
 *    2026-11-25). So every flag component a section_map names must declare
 *    one. The flag set is DERIVED from every section_map in the release, never
 *    a hand list; a flag still undeclared is a NAMED exemption below, with its
 *    reason, held both ways (a new undeclared flag is red; an exempted flag
 *    that gained its default is red until the exemption is removed).
 *
 * The third block checks the birth seed against the release on the suite DB:
 * for every flag whose thesaurus section is installed there, the seed's value
 * is the release's declaration, int ids.
 */

import { describe, expect, test } from 'bun:test';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import {
	getSectionDefaultsSpec,
	normalizeDefaultItems,
} from '../../src/core/section/record/record_defaults.ts';
import {
	locatorTipo,
	type ReleaseRecord,
	readReleaseOntology,
	releaseNodesOfModel,
} from '../helpers/release_ontology.ts';

const records = readReleaseOntology();

/** The section_map scope keys that name a yes/no flag component. */
const FLAG_KEYS = ['is_descriptor', 'is_indexable'] as const;

/**
 * Flag components the release names WITHOUT a dato_default — each awaiting an
 * owner decision on the master ontology (never fixed here: ontology nodes
 * belong to the master). Shrink-only.
 */
/** Birth-seed checks on a fresh suite DB (measured 2026-11-25). */
const CHECKED_FLOOR = 12;

const UNDECLARED_PENDING_OWNER: Readonly<Record<string, string>> = {
	dd1445:
		"is_descriptor of dd1100's section_map (the 'web dedalo' thesaurus) — not among the five " +
		'carriers M4 ruled on (2026-11-25 release); a tree-created term there is born with no ' +
		'is_descriptor until the master ontology declares one',
};

interface FlagUse {
	sectionMap: string;
	section: string;
	key: (typeof FLAG_KEYS)[number];
	flag: string;
}

function flagUses(): { maps: ReleaseRecord[]; uses: FlagUse[]; literals: number } {
	const maps = releaseNodesOfModel(records, 'section_map');
	const uses: FlagUse[] = [];
	let literals = 0;
	for (const map of maps) {
		for (const scope of Object.values(map.properties ?? {})) {
			if (scope === null || typeof scope !== 'object') continue;
			for (const key of FLAG_KEYS) {
				const value = (scope as Record<string, unknown>)[key];
				if (value === undefined) continue;
				for (const flag of Array.isArray(value) ? value : [value]) {
					// `false` states "this thesaurus has no such flag" — nothing to default.
					if (typeof flag !== 'string') {
						literals++;
						continue;
					}
					uses.push({ sectionMap: map.tipo, section: map.parent ?? '', key, flag });
				}
			}
		}
	}
	return { maps, uses, literals };
}

function declaredDefault(flag: string): unknown[] | null {
	const value = records.get(flag)?.properties?.dato_default;
	return Array.isArray(value) && value.length > 0 ? value : null;
}

describe('the vendored release is read (floors)', () => {
	test('records, section_maps and flag uses are all present', () => {
		// Floors = the 7.0 release as measured 2026-11-25 (fbbd8e9bd8). SHRINK-ONLY:
		// a release that carries fewer is a reviewed edit here, never a silent pass.
		const { maps, uses } = flagUses();
		expect(records.size).toBeGreaterThanOrEqual(16_221);
		expect(maps.length).toBeGreaterThanOrEqual(35);
		expect(uses.length).toBeGreaterThanOrEqual(36);
		expect(new Set(uses.map((use) => use.flag)).size).toBeGreaterThanOrEqual(34);
	});
});

describe('T2-RC-3 / M2 — dd170 (component_filter_master) relates dd153', () => {
	test('dd170 is a component_filter_master whose relations include the projects section dd153', () => {
		const filterMaster = records.get('dd170');
		expect(filterMaster).toBeDefined();
		const modelTipo =
			filterMaster?.modelLocator === null || filterMaster === undefined
				? null
				: locatorTipo(filterMaster.modelLocator);
		expect(records.get(modelTipo ?? '')?.machineName).toBe('component_filter_master');
		expect(filterMaster?.relations).toContain('dd153');
		expect(releaseNodesOfModel(records, 'section').map((node) => node.tipo)).toContain('dd153');
	});
});

describe('T2-THES-04 / M4 — every section_map flag component declares a dato_default', () => {
	test('every named flag exists in the release', () => {
		const dangling = flagUses()
			.uses.filter((use) => !records.has(use.flag))
			.map((use) => `${use.sectionMap}.${use.key} → ${use.flag}`);
		expect(dangling).toEqual([]);
	});

	test('undeclared flags = exactly the named owner exemptions', () => {
		const undeclared = [
			...new Set(
				flagUses()
					.uses.filter((use) => declaredDefault(use.flag) === null)
					.map((use) => use.flag),
			),
		].sort();
		expect(undeclared).toEqual(Object.keys(UNDECLARED_PENDING_OWNER).sort());
	});

	test('each declared default is a non-empty list of well-formed locators', () => {
		const malformed: string[] = [];
		for (const use of flagUses().uses) {
			for (const locator of declaredDefault(use.flag) ?? []) {
				const { section_tipo, section_id } = (locator ?? {}) as Record<string, unknown>;
				if (typeof section_tipo !== 'string' || !/^\d+$/.test(String(section_id))) {
					malformed.push(`${use.flag}: ${JSON.stringify(locator)}`);
				}
			}
		}
		expect(malformed).toEqual([]);
	});
});

describe('the record-birth seed applies each declared flag default AS DECLARED (suite DB)', () => {
	test('for every installed thesaurus section: seed value = release declaration, int ids', async () => {
		let checked = 0;
		const mismatches: string[] = [];
		for (const use of flagUses().uses) {
			const declared = declaredDefault(use.flag);
			if (declared === null) continue;
			if ((await getModelByTipo(use.section)) !== 'section') continue; // TLD not installed here
			const spec = await getSectionDefaultsSpec(use.section);
			const item = spec.items.find((candidate) => candidate.tipo === use.flag);
			if (item === undefined) {
				mismatches.push(`${use.section}.${use.key} ${use.flag}: not seeded`);
				continue;
			}
			const { items } = await normalizeDefaultItems(item.tipo, item.model, item.values);
			const seeded = items.map((stored) => {
				const { section_tipo, section_id } = stored as Record<string, unknown>;
				return { section_tipo, section_id };
			});
			const expected = declared.map((locator) => {
				const { section_tipo, section_id } = locator as Record<string, unknown>;
				return { section_tipo, section_id: Number(section_id) };
			});
			if (JSON.stringify(seeded) !== JSON.stringify(expected)) {
				mismatches.push(
					`${use.section}.${use.key} ${use.flag}: seeded ${JSON.stringify(seeded)} ≠ declared ${JSON.stringify(expected)}`,
				);
			}
			checked++;
		}
		expect(mismatches).toEqual([]);
		// The suite DB installs the core TLDs (dd, hierarchy, ontology, rsc): their
		// thesauri carry most of the release's flags. Floor = the count measured on
		// a fresh suite DB, 2026-11-25 — SHRINK-ONLY, as above.
		expect(checked).toBeGreaterThanOrEqual(CHECKED_FLOOR);
	});
});
