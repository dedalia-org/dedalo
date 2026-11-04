/**
 * LEVEL >= 2 'self' REFUSAL (src/core/relations/request_config/self_depth.ts),
 * owner decision (c) of the nested-ddo_map plan: a `section_tipo: 'self'` ddo
 * is accepted only as a DIRECT child of the config owner; deeper it is skipped
 * with a typed `ontology.ddo_self_refused` notice naming owner, ddo and parent.
 *
 * Pure: abstract tipos (`P` the owner portal, `AC` a nested autocomplete,
 * `NAME` its child) — the rule keys on the parent chain alone.
 */

import { describe, expect, test } from 'bun:test';
import { SCALAR_BOUNDS } from '../../src/core/concepts/scalar_bounds.ts';
import { noticeSchema } from '../../src/core/errors/schema.ts';
import { getLabels } from '../../src/core/labels/catalog.ts';
import {
	DDO_SELF_REFUSED_CODE,
	partitionDeepSelfDdos,
	refuseDeepSelfSectionTipo,
	sectionTipoNamesSelf,
	splitSelfSectionTipoEntry,
} from '../../src/core/relations/request_config/self_depth.ts';

describe('refuseDeepSelfSectionTipo — one ddo at a known depth', () => {
	test("first-level 'self' is unchanged (no notice)", () => {
		expect(
			refuseDeepSelfSectionTipo('P', { tipo: 'AC', parent: 'self', section_tipo: 'self' }, 1),
		).toBeNull();
	});

	test("depth 2 'self' → a schema-valid typed notice naming owner, ddo, parent, depth", () => {
		const notice = refuseDeepSelfSectionTipo(
			'P',
			{ tipo: 'NAME', parent: 'AC', section_tipo: 'self' },
			2,
		);
		expect(notice).not.toBeNull();
		expect(noticeSchema.safeParse(notice).success).toBe(true);
		expect(notice?.code).toBe(DDO_SELF_REFUSED_CODE);
		expect(notice?.label_key).toBe('error_ontology_ddo_self_refused');
		expect(notice?.details).toEqual({ owner: 'P', ddo: 'NAME', parent: 'AC', depth: 2, more: 0 });
	});

	test('an explicit section_tipo at any depth is kept', () => {
		expect(
			refuseDeepSelfSectionTipo('P', { tipo: 'NAME', parent: 'AC', section_tipo: 'people1' }, 3),
		).toBeNull();
		expect(
			refuseDeepSelfSectionTipo(
				'P',
				{ tipo: 'NAME', parent: 'AC', section_tipo: [{ value: [1], source: 'hierarchy_types' }] },
				2,
			),
		).toBeNull();
	});

	test("every spelling of 'self' counts (string, inside an array, {source:'self'}, inside a section entry's value)", () => {
		expect(sectionTipoNamesSelf('self')).toBe(true);
		expect(sectionTipoNamesSelf(['other1', 'self'])).toBe(true);
		expect(sectionTipoNamesSelf([{ source: 'self' }])).toBe(true);
		expect(sectionTipoNamesSelf([{ source: 'section', value: ['self'] }])).toBe(true);
		expect(sectionTipoNamesSelf({ source: 'section', value: 'self' })).toBe(true);
		expect(sectionTipoNamesSelf([{ source: 'section_tipo', value: ['people1', 'self'] }])).toBe(
			true,
		);
		expect(sectionTipoNamesSelf(['other1'])).toBe(false);
		expect(sectionTipoNamesSelf([{ source: 'section', value: ['people1'] }])).toBe(false);
		expect(sectionTipoNamesSelf(undefined)).toBe(false);
		// section_model's 'self' / no value = the owner's MODEL TWIN — its own meaning, not the sentinel
		expect(sectionTipoNamesSelf([{ source: 'section_model' }])).toBe(false);
		expect(sectionTipoNamesSelf([{ source: 'section_model', value: ['self'] }])).toBe(false);
		for (const sectionTipo of [
			['x1', 'self'],
			[{ source: 'self' }],
			[{ source: 'section', value: ['self'] }],
			[{ source: 'section', value: ['people1', 'self'] }],
		]) {
			expect(
				refuseDeepSelfSectionTipo(
					'P',
					{ tipo: 'NAME', parent: 'AC', section_tipo: sectionTipo },
					2,
				),
			).not.toBeNull();
		}
	});
});

describe('splitSelfSectionTipoEntry — a mixed entry splits into the sentinel + the rest', () => {
	test("{source:'section', value:['self','people1']} → self + {source:'section', value:['people1']}", () => {
		expect(splitSelfSectionTipoEntry({ source: 'section', value: ['self', 'people1'] })).toEqual({
			namesSelf: true,
			rest: { source: 'section', value: ['people1'] },
		});
		expect(splitSelfSectionTipoEntry({ source: 'section', value: ['self'] })).toEqual({
			namesSelf: true,
			rest: null,
		});
		const hierarchy = { source: 'hierarchy_types', value: [1] };
		expect(splitSelfSectionTipoEntry(hierarchy)).toEqual({ namesSelf: false, rest: hierarchy });
	});
});

describe('partitionDeepSelfDdos — depth from the parent chain', () => {
	test('owner P: [AC<self (self), NAME<AC (self), SURNAME<AC (explicit)] → NAME refused', () => {
		const map = [
			{ tipo: 'AC', parent: 'self', section_tipo: 'self' },
			{ tipo: 'NAME', parent: 'AC', section_tipo: 'self' },
			{ tipo: 'SURNAME', parent: 'AC', section_tipo: 'people1' },
		];
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(kept.map((ddo) => ddo.tipo)).toEqual(['AC', 'SURNAME']);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.details).toEqual({
			owner: 'P',
			ddo: 'NAME',
			parent: 'AC',
			depth: 2,
			more: 0,
		});
	});

	test("the section-entry spelling is refused at depth 2 too (it used to silently mean the owner's section)", () => {
		const map = [
			{ tipo: 'AC', parent: 'self', section_tipo: 'self' },
			{ tipo: 'NAME', parent: 'AC', section_tipo: [{ source: 'section', value: ['self'] }] },
		];
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(kept.map((ddo) => ddo.tipo)).toEqual(['AC']);
		expect(notices[0]?.details).toEqual({
			owner: 'P',
			ddo: 'NAME',
			parent: 'AC',
			depth: 2,
			more: 0,
		});
	});

	test('parent named by the owner tipo itself is depth 1; depth 3 is reported as 3', () => {
		const map = [
			{ tipo: 'AC', parent: 'P', section_tipo: 'self' },
			{ tipo: 'MID', parent: 'AC', section_tipo: 'people1' },
			{ tipo: 'DEEP', parent: 'MID', section_tipo: 'self' },
		];
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(kept.map((ddo) => ddo.tipo)).toEqual(['AC', 'MID']);
		expect(notices[0]?.details?.depth).toBe(3);
	});

	test('an orphan or cyclic chain has no depth and is kept (no false self report)', () => {
		const map = [
			{ tipo: 'ORPHAN', parent: 'NOWHERE', section_tipo: 'self' },
			{ tipo: 'a', parent: 'b', section_tipo: 'self' },
			{ tipo: 'b', parent: 'a', section_tipo: 'self' },
		];
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(kept).toHaveLength(3);
		expect(notices).toEqual([]);
	});
});

describe('partitionDeepSelfDdos — bounded on a client-sent map', () => {
	test('a back-edge of a cycle hanging off a real chain has no depth (kept, no report)', () => {
		// AC is depth 1, MID depth 2; the second AC (parent MID) is the cycle's repeat
		const map = [
			{ tipo: 'AC', parent: 'self', section_tipo: 'self' },
			{ tipo: 'MID', parent: 'AC', section_tipo: 'people1' },
			{ tipo: 'AC', parent: 'MID', section_tipo: 'self' },
		];
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(kept).toHaveLength(3);
		expect(notices).toEqual([]);
	});

	test('each tipo declared twice under the previous one (2^k chains) is linear, shallowest depth wins', () => {
		const map: { tipo: string; parent: string; section_tipo: string }[] = [];
		for (let level = 1; level <= 400; level++) {
			const parent = level === 1 ? 'self' : `T${level - 1}`;
			const sectionTipo = level === 400 ? 'self' : 'people1';
			map.push({ tipo: `T${level}`, parent, section_tipo: sectionTipo });
			map.push({ tipo: `T${level}`, parent, section_tipo: sectionTipo });
		}
		const started = performance.now();
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(kept).toHaveLength(798);
		// T400 declared twice under T399: one definition to correct, one notice
		expect(notices).toHaveLength(1);
		expect(notices[0]?.details?.depth).toBe(400);
		expect(notices[0]?.details?.more).toBe(0);
	});

	test('2047 refused ddos → every one skipped, at most ddoMapWarnings notices, the rest counted in `more`', () => {
		const map: { tipo: string; parent: string; section_tipo: string }[] = [
			{ tipo: 'A', parent: 'self', section_tipo: 'zzsdp1' },
		];
		for (let index = 1; index <= 2047; index++) {
			map.push({ tipo: `B${index}`, parent: 'A', section_tipo: 'self' });
		}
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(kept.map((ddo) => ddo.tipo)).toEqual(['A']);
		expect(notices).toHaveLength(SCALAR_BOUNDS.ddoMapWarnings);
		expect(notices.map((notice) => notice.details?.ddo)).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
		// The batch remainder rides the LAST shown notice only (counted once — the
		// registry folds `more` as "what this notice stands for beyond itself").
		expect(notices.map((notice) => notice.details?.more)).toEqual([
			...Array(SCALAR_BOUNDS.ddoMapWarnings - 1).fill(0),
			2047 - SCALAR_BOUNDS.ddoMapWarnings,
		]);
		for (const notice of notices) {
			expect(noticeSchema.safeParse(notice).success).toBe(true);
		}
	});

	test('the same (ddo, parent) declared twice is ONE notice; a different parent is another', () => {
		const map = [
			{ tipo: 'X', parent: 'self', section_tipo: 'zzsdp1' },
			{ tipo: 'Y', parent: 'self', section_tipo: 'zzsdp1' },
			{ tipo: 'N', parent: 'X', section_tipo: 'self' },
			{ tipo: 'N', parent: 'X', section_tipo: 'self' },
			{ tipo: 'N', parent: 'Y', section_tipo: 'self' },
		];
		const { kept, notices } = partitionDeepSelfDdos('P', map);
		expect(kept.map((ddo) => ddo.tipo)).toEqual(['X', 'Y']);
		expect(notices.map((notice) => [notice.details?.ddo, notice.details?.parent])).toEqual([
			['N', 'X'],
			['N', 'Y'],
		]);
	});

	test('a huge client "tipo" is never echoed verbatim in the notice', () => {
		const huge = `T${'x'.repeat(10_000)}`;
		const { notices } = partitionDeepSelfDdos('P', [
			{ tipo: 'A', parent: 'self', section_tipo: 'zzsdp1' },
			{ tipo: huge, parent: 'A', section_tipo: 'self' },
		]);
		expect(notices).toHaveLength(1);
		expect(String(notices[0]?.details?.ddo).length).toBeLessThanOrEqual(65);
	});
});

describe('the notice is wired into the label catalog', () => {
	test('master.json carries the label and spells every details key as a placeholder', async () => {
		const labels = (await getLabels('lg-eng')) as Record<string, string>;
		const text = labels.error_ontology_ddo_self_refused;
		expect(typeof text).toBe('string');
		for (const key of ['owner', 'ddo', 'parent', 'depth', 'more'])
			expect(text).toContain(`\${${key}}`);
	});
});
