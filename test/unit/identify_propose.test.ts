/**
 * ELEMENT PROPOSALS (src/ai/identify/propose.ts) — "AI proposes, human
 * confirms", the no-model tier.
 *
 * Three things are tested here, in the order they can go wrong:
 *
 *  1. THE VOTE, as pure logic over injected fakes. A proposal is an assertion
 *     about someone's collection made from other people's records; the arithmetic
 *     that produces its confidence has to be checkable without a corpus, or it
 *     ends up verified for the two cases a fixture happened to cover.
 *  2. THE GATES. A proposal QUOTES its neighbours' values, so a neighbour the
 *     caller cannot read must contribute no vote AND appear in no evidence.
 *     That is an information leak, not a permissions nicety, so it is tested
 *     from both directions: what comes out, and what is even read.
 *  3. THE ABSENCE OF A WRITE SEAM, statically. IDENTIFY_PLAN §7.1 ("nothing on
 *     the identification path writes a component value outside an explicit
 *     curator confirmation") is the invariant this whole feature rests on, and
 *     per the project's tripwire-or-delete law it gets a mechanical gate rather
 *     than a promise in a header.
 *
 * The last block is DB-backed against the canonical `test3` playground, and is
 * READ-ONLY: it seeds nothing and writes nothing (test3/2 records none of the
 * criteria, test3/1 and test3/27 do — which is the gap-filling shape in
 * miniature). It skips honestly when no Postgres is reachable.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	buildNeighbourFinder,
	type CategoricalElementProposal,
	type ElementProposal,
	type NeighbourFinder,
	type NeighbourPorts,
	type ProposalNeighbour,
	proposeElements,
} from '../../src/ai/identify/propose.ts';
import { type AccessFilter, IdentifyAccessError } from '../../src/core/identify/match.ts';
import { parseProfile } from '../../src/core/identify/profile.ts';
import type {
	CriterionPathStep,
	CriterionValue,
	IdentificationProfile,
} from '../../src/core/identify/types.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	extractImportSpecifiers,
	FORBIDDEN_WRITE_IMPORTS,
	FORBIDDEN_WRITE_SOURCE,
	listSourceFiles,
	scanFileForWriteSeam,
} from '../helpers/no_write_scan.ts';

/**
 * The vote cases are about voting, so they run as an unscoped admin: the default
 * record gate short-circuits for a global admin and the component grant for the
 * superuser id, so neither touches the database. The ACCESS cases inject their
 * own gates and assert them directly.
 */
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: false };
const CURATOR: Principal = { userId: 7, isGlobalAdmin: false, isDeveloper: false };

const SEED = { sectionTipo: 'test3', sectionId: 1 };

/** Everything is readable unless a case says otherwise. */
const allowAll: AccessFilter = async (_principal, records) => [...records];
/** Every component is readable unless a case says otherwise. */
const grantAll = async () => 1;

function criterion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'deity',
		label: 'Deity',
		path: [{ section_tipo: 'test3', component_tipo: 'deity' }],
		role: 'identifying',
		weight: 1,
		mode: 'same_locator',
		...overrides,
	};
}

function profileWith(criteria: unknown[]): IdentificationProfile {
	return parseProfile({ id: 'p', label: 'P', sectionTipos: ['test3'], criteria });
}

const locators = (...ids: number[]): CriterionValue => ({
	kind: 'locators',
	locators: ids.map((id) => ({ section_tipo: 'term1', section_id: id })),
});
const text = (...values: string[]): CriterionValue => ({ kind: 'text', values });
const numbers = (...values: number[]): CriterionValue => ({ kind: 'number', values });
const dates = (...ranges: Array<[number, number]>): CriterionValue => ({
	kind: 'date',
	ranges: ranges.map(([from, to]) => ({ from, to })),
});

/** Values keyed by "sectionId|componentTipo", so a fake reader can serve a corpus. */
function readerFor(corpus: Record<string, CriterionValue | null>) {
	return async (
		record: { sectionTipo: string; sectionId: number },
		path: CriterionPathStep[],
	): Promise<CriterionValue | null> =>
		corpus[`${record.sectionId}|${path[path.length - 1]?.component_tipo}`] ?? null;
}

/** A fixed neighbour set, reported as whatever source the case is about. */
function neighboursOf(
	neighbours: ProposalNeighbour[],
	source: 'image_index' | 'structural' = 'structural',
): NeighbourFinder {
	return async () => ({ source, reason: 'fixed by the test', neighbours });
}

function neighbour(sectionId: number, weight: number, thumbUrl: string | null = null) {
	return { sectionTipo: 'test3', sectionId, weight, thumbUrl };
}

/** Narrow to the categorical arm, asserting the kind on the way through. */
function categorical(proposal: ElementProposal | undefined): CategoricalElementProposal {
	expect(proposal?.kind).toBe('categorical');
	return proposal as CategoricalElementProposal;
}

describe('proposeElements — the weighted vote', () => {
	test('proposes the neighbours majority value and cites the records that voted for it', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([
				neighbour(2, 0.9, 'thumb-2.jpg'),
				neighbour(3, 0.8),
				neighbour(4, 0.3),
			]),
			readValues: readerFor({
				// the seed records nothing — this is a gap to fill
				'2|deity': locators(10),
				'3|deity': locators(10),
				'4|deity': locators(99),
			}),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});

		const proposal = report.proposals[0];
		expect(proposal?.kind).toBe('categorical');
		expect(proposal?.display).toBe('term1/10');
		// 1.7 of 2.0 total weight agreed on term1/10.
		expect(proposal?.confidence).toBe(0.85);
		// Only the neighbours that voted for the WINNER are its evidence, and each
		// carries enough to render: locator, weight, thumb when it has one.
		expect(proposal?.evidence.map((e) => e.sectionId)).toEqual([2, 3]);
		expect(proposal?.evidence[0]?.thumbUrl).toBe('thumb-2.jpg');
		expect(proposal?.evidence[0]?.value).toBe('term1/10');
		expect(report.neighboursConsidered).toBe(3);
	});

	test('the run’s data lang reaches the neighbour finder (review M2: the matcher read the install default)', async () => {
		const seen: (string | undefined)[] = [];
		await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			lang: 'lg-cat',
			findNeighbours: async (input) => {
				seen.push(input.lang);
				return { source: 'structural', reason: 'fixed by the test', neighbours: [] };
			},
			readValues: readerFor({}),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(seen).toEqual(['lg-cat']);
	});

	test('confidence IS the vote distribution, not a fixed dial', async () => {
		const split = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1), neighbour(3, 1)]),
			readValues: readerFor({ '2|deity': locators(10), '3|deity': locators(99) }),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		// A dead heat is a 50% claim and says so, with both options visible.
		expect(split.proposals[0]?.confidence).toBe(0.5);
		expect(categorical(split.proposals[0]).distribution).toEqual([
			{ value: 'term1/10', share: 0.5 },
			{ value: 'term1/99', share: 0.5 },
		]);

		const unanimous = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 0.4), neighbour(3, 0.1)]),
			readValues: readerFor({ '2|deity': locators(10), '3|deity': locators(10) }),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(unanimous.proposals[0]?.confidence).toBe(1);
	});

	test('the winning value comes back structured, ready for the confirm flow to save', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1)]),
			readValues: readerFor({ '2|deity': locators(10) }),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		// A display string alone would force the acceptance path to re-resolve what
		// the proposal already knew exactly.
		expect(report.proposals[0]?.value).toEqual({
			kind: 'locators',
			locators: [{ section_tipo: 'term1', section_id: 10 }],
		});
	});

	test('text votes group on the normalized form but keep the spelling they were written in', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion({ mode: 'normalized_text' })]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1), neighbour(3, 1), neighbour(4, 1)]),
			readValues: readerFor({
				'2|deity': text('Athena'),
				'3|deity': text('  athéna '),
				'4|deity': text('Nike'),
			}),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		// Case and accents are not identity (the rule match.ts compares by), so the
		// two spellings are ONE candidate with two votes — not two singletons that
		// let 'Nike' win a three-way split.
		expect(report.proposals[0]?.display).toBe('Athena');
		expect(report.proposals[0]?.confidence).toBeCloseTo(2 / 3, 4);
	});

	test('numeric votes cluster inside the criterion tolerance', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion({ mode: 'numeric_tolerance', tolerance: 1 })]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1), neighbour(3, 1), neighbour(4, 1)]),
			readValues: readerFor({
				'2|deity': numbers(9.1),
				'3|deity': numbers(9.4),
				'4|deity': numbers(20),
			}),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		// 9.1 and 9.4 are the same measurement at a 1 g tolerance; 20 is not.
		expect(report.proposals[0]?.confidence).toBeCloseTo(2 / 3, 4);
		expect(report.proposals[0]?.display).toBe('9.1');
	});

	test('a date criterion proposes a RANGE, with the ordinal span an acceptance could save', async () => {
		const year = 372 * 24 * 60 * 60;
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion({ id: 'period', label: 'Period', mode: 'date_overlap' })]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1), neighbour(3, 1)]),
			readValues: readerFor({
				'2|deity': dates([100 * year, 120 * year]),
				'3|deity': dates([110 * year, 150 * year]),
			}),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		const proposal = report.proposals[0];
		expect(proposal?.kind).toBe('date_range');
		expect(proposal?.value).toEqual({
			kind: 'date',
			ranges: [{ from: 100 * year, to: 150 * year }],
		});
		expect(proposal?.evidence).toHaveLength(2);
	});
});

describe('proposeElements — proposals fill gaps, they do not argue', () => {
	test('a criterion the seed already records gets NO proposal, and says why', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1)]),
			readValues: readerFor({
				'1|deity': locators(7), // the curator already answered this
				'2|deity': locators(10),
			}),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(report.proposals).toEqual([]);
		expect(report.skipped).toEqual([
			{
				criterionId: 'deity',
				label: 'Deity',
				reason: 'already_recorded',
				detail: 'the record already records a value at this path',
			},
		]);
	});

	test('a gap and an answered criterion are handled independently in one run', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([
				criterion(),
				criterion({
					id: 'symbol',
					label: 'Symbol',
					path: [{ section_tipo: 'test3', component_tipo: 'symbol' }],
				}),
			]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1)]),
			readValues: async (record, path) => {
				const key = `${record.sectionId}|${path[0]?.component_tipo}`;
				return (
					{ '1|deity': locators(7), '2|deity': locators(10), '2|symbol': locators(20) }[key] ?? null
				);
			},
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(report.proposals.map((p) => p.criterionId)).toEqual(['symbol']);
		expect(report.skipped.map((s) => s.criterionId)).toEqual(['deity']);
	});

	test('an ignored criterion and an image-similarity criterion are declined, not silently dropped', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([
				criterion({ id: 'off', role: 'ignored' }),
				criterion({ id: 'looks', mode: 'image_similarity', tolerance: 0.8 }),
			]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1)]),
			readValues: readerFor({ '2|deity': locators(10) }),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(report.proposals).toEqual([]);
		expect(report.skipped.map((s) => s.reason)).toEqual(['ignored_role', 'not_votable']);
	});

	test('nothing to vote on is reported as such, never as an empty confident answer', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1)]),
			readValues: readerFor({}), // nobody records anything
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(report.proposals).toEqual([]);
		expect(report.skipped[0]?.reason).toBe('no_neighbour_values');
	});

	test('the seed never votes for itself', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			// A retrieval leg that failed to exclude the seed must not turn the
			// record's own (absent) value into evidence about itself.
			findNeighbours: neighboursOf([neighbour(1, 5), neighbour(2, 1)]),
			readValues: readerFor({ '2|deity': locators(10) }),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(report.neighboursConsidered).toBe(1);
		expect(report.proposals[0]?.evidence.map((e) => e.sectionId)).toEqual([2]);
	});
});

describe('proposeElements — access control', () => {
	/** An ACL that admits only the listed section_ids. */
	function allowOnly(...ids: number[]): AccessFilter {
		return async (_principal, records) => records.filter((r) => ids.includes(r.sectionId));
	}

	test('a seed the principal cannot read is refused, not answered with an empty proposal set', async () => {
		await expect(
			proposeElements({
				principal: CURATOR,
				profile: profileWith([criterion()]),
				seed: SEED,
				findNeighbours: neighboursOf([neighbour(2, 1)]),
				readValues: readerFor({ '2|deity': locators(10) }),
				filterAccessible: allowOnly(999),
				componentGrant: grantAll,
			}),
		).rejects.toThrow(IdentifyAccessError);
	});

	test('a denied neighbour contributes no vote, appears in no evidence, and is never READ', async () => {
		const readRecordIds: number[] = [];
		const corpus = readerFor({
			'2|deity': locators(10),
			'3|deity': locators(66), // the denied record — heaviest, would win if counted
		});
		const report = await proposeElements({
			principal: CURATOR,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1), neighbour(3, 50)]),
			readValues: async (record, path) => {
				readRecordIds.push(record.sectionId);
				return corpus(record, path);
			},
			filterAccessible: allowOnly(1, 2),
			componentGrant: grantAll,
		});

		expect(report.proposals[0]?.display).toBe('term1/10');
		expect(report.proposals[0]?.confidence).toBe(1);
		expect(categorical(report.proposals[0]).distribution.map((d) => d.value)).toEqual(['term1/10']);
		expect(report.proposals[0]?.evidence.map((e) => e.sectionId)).toEqual([2]);
		// The gate has to run BEFORE the read: the read is what pulls the other
		// record's value into a string a curator would see.
		expect(readRecordIds).not.toContain(3);
	});

	test('a denied principal gets nothing at all', async () => {
		const report = await proposeElements({
			principal: CURATOR,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1), neighbour(3, 1)]),
			readValues: readerFor({ '2|deity': locators(10), '3|deity': locators(10) }),
			filterAccessible: allowOnly(1), // the seed only
			componentGrant: grantAll,
		});
		expect(report.proposals).toEqual([]);
		expect(report.neighboursConsidered).toBe(0);
		// And no count of what was hidden: that would be an existence oracle.
		expect(JSON.stringify(report)).not.toContain('hidden');
	});

	test('a component the principal cannot read is re-gated per criterion, not assumed by the record grant', async () => {
		// dd774 grants are per-(section, component): a caller may open the record
		// and still be denied the component this criterion quotes.
		const readRecordIds: number[] = [];
		const corpus = readerFor({ '2|secret': locators(10), '3|secret': locators(10) });
		const report = await proposeElements({
			principal: CURATOR,
			profile: profileWith([
				criterion({ path: [{ section_tipo: 'test3', component_tipo: 'secret' }] }),
			]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1), neighbour(3, 1)]),
			readValues: async (record, path) => {
				readRecordIds.push(record.sectionId);
				return corpus(record, path);
			},
			filterAccessible: allowAll,
			componentGrant: async (_principal, _sectionTipo, componentTipo) =>
				componentTipo === 'secret' ? 0 : 1,
		});
		expect(report.proposals).toEqual([]);
		expect(readRecordIds).toEqual([1]); // only the seed's own gap check
	});

	test('a multi-hop criterion gates the LEAF component too, in the section it lives in', async () => {
		// Coin → Type → Legend: the entry component sits on the neighbour, the leaf
		// sits in another section. Being allowed the hop says nothing about the leaf.
		const asked: string[] = [];
		const report = await proposeElements({
			principal: CURATOR,
			profile: profileWith([
				criterion({
					path: [
						{ section_tipo: 'test3', component_tipo: 'type_portal' },
						{ section_tipo: 'test4', component_tipo: 'legend' },
					],
				}),
			]),
			seed: SEED,
			findNeighbours: neighboursOf([neighbour(2, 1)]),
			readValues: readerFor({ '2|legend': text('ATHENA') }),
			filterAccessible: allowAll,
			componentGrant: async (_principal, sectionTipo, componentTipo) => {
				asked.push(`${sectionTipo}/${componentTipo}`);
				return componentTipo === 'legend' ? 0 : 1;
			},
		});
		expect(asked).toContain('test3/type_portal');
		expect(asked).toContain('test4/legend');
		expect(report.proposals).toEqual([]);
	});
});

describe('buildNeighbourFinder — which leg ran is part of the answer', () => {
	function ports(overrides: Partial<NeighbourPorts> = {}): NeighbourPorts {
		return {
			hasImageIndex: async () => false,
			imageNeighbours: async () => [],
			structuralNeighbours: async () => [neighbour(9, 0.7)],
			...overrides,
		};
	}
	const call = (finder: NeighbourFinder) =>
		finder({
			profile: profileWith([criterion()]),
			seed: SEED,
			principal: ADMIN,
			topK: 5,
		});

	test('the run’s data lang reaches the structural leg on both paths (review M2)', async () => {
		const seen: (string | undefined)[] = [];
		const structuralNeighbours: NeighbourPorts['structuralNeighbours'] = async ({ lang }) => {
			seen.push(lang);
			return [];
		};
		const input = {
			profile: profileWith([criterion()]),
			seed: SEED,
			principal: ADMIN,
			topK: 5,
			lang: 'lg-cat',
		};
		await buildNeighbourFinder(ports({ structuralNeighbours }))(input);
		await buildNeighbourFinder(
			ports({
				hasImageIndex: async () => true,
				imageNeighbours: async () => [],
				structuralNeighbours,
			}),
		)(input);
		expect(seen).toEqual(['lg-cat', 'lg-cat']);
	});

	test('no image index → structural neighbours, REPORTED as structural', async () => {
		const report = await call(buildNeighbourFinder(ports()));
		expect(report.source).toBe('structural');
		expect(report.reason).toContain('no image index');
		expect(report.neighbours.map((n) => n.sectionId)).toEqual([9]);
	});

	test('an image index with visual neighbours → the image leg', async () => {
		const report = await call(
			buildNeighbourFinder(
				ports({
					hasImageIndex: async () => true,
					imageNeighbours: async () => [neighbour(4, 0.9)],
				}),
			),
		);
		expect(report.source).toBe('image_index');
		expect(report.neighbours.map((n) => n.sectionId)).toEqual([4]);
	});

	test('an image index that returns nothing falls back EXPLICITLY, never silently', async () => {
		// A section can be image-indexed while this record has no photograph yet.
		// Falling back is right; presenting the fallback as a visual result is not.
		let structuralRan = false;
		const report = await call(
			buildNeighbourFinder(
				ports({
					hasImageIndex: async () => true,
					imageNeighbours: async () => [],
					structuralNeighbours: async () => {
						structuralRan = true;
						return [neighbour(9, 0.7)];
					},
				}),
			),
		);
		expect(structuralRan).toBe(true);
		expect(report.source).toBe('structural');
		expect(report.reason).toContain('fell back');
	});

	test('the source reaches the caller through proposeElements untouched', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile: profileWith([criterion()]),
			seed: SEED,
			findNeighbours: buildNeighbourFinder(ports()),
			readValues: readerFor({ '9|deity': locators(10) }),
			filterAccessible: allowAll,
			componentGrant: grantAll,
		});
		expect(report.neighbourSource).toBe('structural');
		expect(report.neighbourSourceReason).toContain('no image index');
	});
});

/**
 * THE INVARIANT THIS FEATURE RESTS ON (IDENTIFY_PLAN §7.1): nothing on the
 * proposal path writes. Asserted mechanically, per the tripwire-or-delete law —
 * a header promise would rot the first time someone "just" enqueued a job here.
 * The check is on DIRECT imports and on the module's own SQL: the module reads
 * through core (which of course reaches the database), and the line that must
 * never be crossed is this module acquiring a way to CHANGE anything.
 */
describe('src/ai/identify — no write seam', () => {
	const DIR = join(import.meta.dir, '..', '..', 'src', 'ai', 'identify');
	const files = listSourceFiles(DIR); // RECURSIVE: a subdirectory is not a blind spot

	test('the directory is not empty (the gate would pass vacuously)', () => {
		expect(files.length).toBeGreaterThan(0);
		// Named, so that a module MOVED out of this directory reddens here instead
		// of quietly leaving the scan.
		expect(files).toContain('propose.ts');
		expect(files).toContain('cluster.ts');
		expect(files).toContain('vision.ts');
	});

	/**
	 * THE GATE'S OWN GATE. The scan is worth exactly what its extractor can see,
	 * and the extractor is a regex. This case is the standing proof that it reads
	 * every import form — the previous one read only `from '…'`, so a single
	 * `await import('…/matrix_write.ts')` walked straight through the flagship
	 * invariant of this subsystem.
	 */
	test('the extractor sees EVERY import form, dynamic ones included', () => {
		const source = [
			"import { a } from '../../core/db/matrix_write.ts';",
			'import { b } from "../../core/db/json_codec.ts";',
			"export { c } from './relations/save.ts';",
			"const d = await import('../../core/section/record/save_component.ts');",
			'const e = import("../../diffusion/jobs/queue.ts");',
			'const f = require("../../core/tools/background.ts");',
			"import '../../core/api/dispatch.ts';",
			'const g = await import(`../../core/db/dd_ontology.ts`);',
		].join('\n');
		const found = extractImportSpecifiers(source);
		expect(found).toHaveLength(8);
		// …and every one of them is caught by the forbidden list, not merely seen.
		for (const specifier of found) {
			expect(FORBIDDEN_WRITE_IMPORTS.some((forbidden) => specifier.includes(forbidden))).toBe(true);
		}
	});

	test('the source patterns match the write doors that actually exist', () => {
		// A pattern that matches nothing real is a green tick, not a gate: the
		// retired `/\benqueue\s*\(/` matched no call anywhere in this engine.
		const doors = [
			'await scheduleBackground({ action })',
			'await enqueueDiffusionJob({ id })',
			"await sql.unsafe('SELECT 1')",
			"await saveComponent({ tipo: 'x' })",
			'await insertMatrixRecordWithCounter(row)',
			'await withTransaction(async () => {})',
			'sql`INSERT INTO matrix_test (a) VALUES (1)`',
			'sql`DELETE FROM matrix_test`',
			'sql`UPDATE matrix_test SET a = 1`',
		];
		for (const door of doors) {
			expect(FORBIDDEN_WRITE_SOURCE.some((pattern) => pattern.test(door))).toBe(true);
		}
		// …and it does not fire on an ordinary read.
		expect(
			FORBIDDEN_WRITE_SOURCE.some((pattern) =>
				pattern.test('const rows = await readPathValues(seed, path)'),
			),
		).toBe(false);
	});

	for (const name of files) {
		test(`${name} imports no write module and issues no DML`, () => {
			expect(scanFileForWriteSeam(join(DIR, name), name)).toEqual([]);
		});
	}
});

/**
 * DB-BACKED, READ-ONLY. The canonical test3 playground is exactly the shape this
 * feature is for: test3/2 records none of the criteria, while test3/1 and
 * test3/27 do. The neighbour SET is injected (retrieval is not what this case
 * proves), but the values, the reader, the ACL and the component grant are the
 * production ones — which is the half that a fake reader can never check.
 */
describe.if(DB_READY)('proposeElements — against the test3 playground', () => {
	const profile = profileWith([
		criterion({
			id: 'label',
			label: 'Label',
			path: [{ section_tipo: 'test3', component_tipo: 'test52' }],
			mode: 'normalized_text',
		}),
		criterion({
			id: 'links',
			label: 'Links',
			path: [{ section_tipo: 'test3', component_tipo: 'test88' }],
			mode: 'same_locator',
		}),
	]);

	test('fills an empty record’s gaps from the records that do carry values', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile,
			seed: { sectionTipo: 'test3', sectionId: 2 }, // records neither criterion
			lang: 'lg-eng',
			findNeighbours: neighboursOf([
				{ sectionTipo: 'test3', sectionId: 1, weight: 0.9, thumbUrl: null },
				{ sectionTipo: 'test3', sectionId: 27, weight: 0.3, thumbUrl: null },
			]),
		});

		expect(report.neighboursConsidered).toBe(2);
		expect(report.skipped).toEqual([]);

		const label = report.proposals.find((p) => p.criterionId === 'label');
		// test3/1 holds 'input text content of one' (weight .9); test3/27 falls back
		// to its lg-spa 'El dos' (weight .3) — 0.9 of 1.2 agreed.
		expect(label?.display).toBe('input text content of one');
		expect(label?.confidence).toBe(0.75);
		expect(label?.evidence.map((e) => e.sectionId)).toEqual([1]);
		expect(
			categorical(label)
				.distribution.map((d) => d.value)
				.sort(),
		).toEqual(['El dos', 'input text content of one']);

		const links = report.proposals.find((p) => p.criterionId === 'links');
		// Only test3/1 links anything, and it links dd64/1 AND dd64/2 — a
		// multi-valued component attests both, so the vote is an even split.
		expect(links?.kind).toBe('categorical');
		expect(
			categorical(links)
				.distribution.map((d) => d.value)
				.sort(),
		).toEqual(['dd64/1', 'dd64/2']);
		expect(links?.confidence).toBe(0.5);
		expect(links?.evidence.map((e) => e.sectionId)).toEqual([1]);
	});

	test('a criterion the record already answers is left alone (test3/1 as the seed)', async () => {
		const report = await proposeElements({
			principal: ADMIN,
			profile,
			seed: { sectionTipo: 'test3', sectionId: 1 }, // records BOTH criteria
			lang: 'lg-eng',
			findNeighbours: neighboursOf([
				{ sectionTipo: 'test3', sectionId: 27, weight: 0.9, thumbUrl: null },
			]),
		});
		expect(report.proposals).toEqual([]);
		expect(report.skipped.map((s) => s.reason)).toEqual(['already_recorded', 'already_recorded']);
	});
});
