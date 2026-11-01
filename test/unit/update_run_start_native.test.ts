/**
 * STARTING A RUN FROM THE PANEL'S REQUEST (update audit 2026-10-29, Phase 2.6;
 * U-33, U-41) — src/core/update/run/start.ts + release_plans_wire.ts.
 *
 *  - the master's manifest carries the plan of every catalog release above the
 *    asker (steps as kind/min only, the data version); the consumer reads them
 *    shape-checked — a malformed entry poisons the whole read, never a part;
 *  - the run plans only from a manifest the SERVER fetched and that offers the
 *    chosen item (URL + sha256): an unoffered item refuses before any plan;
 *  - a run that ends short of a confirm is a failed job, never a quiet success;
 *  - the swap landed iff the booted tree carries the run's digest (a developer
 *    build keeps its version);
 *  - the client's reading of /health's update_run covers every server state.
 */

import { describe, expect, test } from 'bun:test';
import {
	resolve_final_frame,
	run_progress,
} from '../../client/dedalo/core/area_maintenance/widgets/update_code/js/update_code_phases.js';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { RELEASE_PLANS, UPDATE_CATALOG } from '../../src/core/update/catalog.ts';
import { DEFAULT_RELEASE_STEPS, type ReleasePlan } from '../../src/core/update/catalog_file.ts';
import { buildCodeUpdateInfo, type CodeReleaseItem } from '../../src/core/update/code_manifest.ts';
import { readWirePlans, wirePlansAbove } from '../../src/core/update/release_plans_wire.ts';
import { runsTargetTree } from '../../src/core/update/run/executor.ts';
import { createRunJournal } from '../../src/core/update/run/journal.ts';
import { isDefaultOntologyStep } from '../../src/core/update/run/production.ts';
import {
	codeRunAnswer,
	type ManifestFetch,
	outcomeOrThrow,
	plansFromMaster,
} from '../../src/core/update/run/start.ts';
import { type RunState, TERMINAL_STATES } from '../../src/core/update/run/states.ts';
import { compareVersionArrays, parseVersionString } from '../../src/core/update/version.ts';

const plan = (
	version: string,
	compat: ReleasePlan['compat'],
	steps: ReleasePlan['steps'],
): ReleasePlan => ({
	version,
	compat,
	steps,
	declared: true,
});
const PLANS: Record<string, ReleasePlan> = {
	'7.0.1': plan('7.0.1', null, [{ kind: 'code' }]),
	'7.0.2': plan('7.0.2', 'compatible', [{ kind: 'code' }, { kind: 'schema' }]),
	'7.1.0': plan('7.1.0', 'incompatible', [
		{ kind: 'ontology', min: '7.0.2' },
		{ kind: 'code' },
		{ kind: 'data', sql: ['sql/7.1.0/a.sql'] },
	]),
};

/** The triple one step below `triple` (its last non-zero part decremented); throws at 0.0.0. */
function belowTriple(triple: readonly number[]): number[] {
	let at = triple.length - 1;
	while (at >= 0 && triple[at] === 0) at--;
	if (at === -1) throw new Error(`no asker below ${triple.join('.')}`);
	return triple.map((part, index) => (index === at ? part - 1 : index > at ? 0 : part));
}

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return null;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return null;
}

describe('the walk’s plans on the wire', () => {
	test('master: every release above the asker, ascending; steps as kind/min only; the data version', () => {
		const wire = wirePlansAbove([7, 0, 1], PLANS, {});
		expect(wire.map((entry) => entry.version)).toEqual(['7.0.2', '7.1.0']);
		expect(wire[1]?.steps).toEqual([
			{ kind: 'ontology', min: '7.0.2' },
			{ kind: 'code' },
			{ kind: 'data' },
		]);
		expect(wire[1]?.compat).toBe('incompatible');
		expect(wire[1]?.data).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test('the manifest answer carries them: exactly the shipped catalog’s plans above the asker', () => {
		// The asker is 7.0.0 when the shipped catalog has a release above it; else
		// one step below its lowest release — never an asker with nothing above,
		// which would compare [] with [] and prove nothing.
		const triples = Object.values(RELEASE_PLANS)
			.map((entry) => parseVersionString(entry.version))
			.sort(compareVersionArrays);
		const lowest = triples[0];
		if (lowest === undefined) throw new Error('the shipped catalog has no release plan at all');
		const asker = triples.some((triple) => compareVersionArrays(triple, [7, 0, 0]) > 0)
			? [7, 0, 0]
			: belowTriple(lowest);
		const info = buildCodeUpdateInfo({
			clientVersion: asker,
			serverVersion: [7, 0, 1],
			codeFilesDir: undefined,
			publicBaseUrl: 'https://master.example',
			info: { date: '', entity_id: null, entity: null, host: null },
		});
		const expected = wirePlansAbove(asker, RELEASE_PLANS, UPDATE_CATALOG);
		expect(expected.length).toBeGreaterThan(0);
		expect(info.plans).toEqual(expected);
	});

	test('consumer: absent → none (an older master); malformed → null, whole; good → plans + data', () => {
		expect(readWirePlans(undefined)).toEqual({ plans: {}, data: {} });
		const good = wirePlansAbove([7, 0, 1], PLANS, {});
		const read = readWirePlans(JSON.parse(JSON.stringify(good)));
		expect(Object.keys(read?.plans ?? {})).toEqual(['7.0.2', '7.1.0']);
		expect(read?.plans['7.1.0']?.compat).toBe('incompatible');
		expect(read?.data['7.0.2']).toHaveLength(3);
		const bad = [good[0], { ...good[1], steps: [{ kind: 'drop_everything' }] }];
		expect(readWirePlans(bad)).toBeNull();
		expect(readWirePlans([{ ...good[0], compat: 'maybe' }])).toBeNull();
		expect(readWirePlans('not a list')).toBeNull();
	});

	test('DECLARED travels: a release that declared no steps stays a DEFAULT plan on the consumer', () => {
		// The regression (2026-11-01, update drill): the reader stamped every wire
		// plan `declared: true`, so a release with the DEFAULT steps made the
		// consumer's default ontology step a DECLARED one — an install with no
		// ontology source failed it after the swap → NEEDS_DB_RESTORE.
		const plans: Record<string, ReleasePlan> = {
			...PLANS,
			'7.0.2': { version: '7.0.2', compat: null, steps: DEFAULT_RELEASE_STEPS, declared: false },
		};
		const wire = JSON.parse(JSON.stringify(wirePlansAbove([7, 0, 1], plans, {})));
		expect(wire.map((entry: { declared: unknown }) => entry.declared)).toEqual([false, true]);
		const read = readWirePlans(wire);
		expect(read?.plans['7.0.2']?.declared).toBe(false);
		expect(read?.plans['7.1.0']?.declared).toBe(true);
		// The OUTCOME, through the predicate the run asks: the default ontology
		// step of a code run is optional; a declared one is not.
		const journal = createRunJournal({
			from: { release: '7.0.1', data: '7.0.1', model: '7.0.1' },
			to: { release: '7.0.2', data: '7.0.1', model: '7.0.1' },
			plan: [
				{ release: '7.0.2', step: { kind: 'code' } },
				{ release: '7.0.2', step: { kind: 'ontology' } },
			],
			releasePlans: read?.plans ?? {},
		});
		expect(isDefaultOntologyStep({ release: '7.0.2' }, journal)).toBe(true);
		expect(isDefaultOntologyStep({ release: '7.1.0' }, journal)).toBe(false);
		// REQUIRED, never guessed: a plan without it poisons the whole read.
		const { declared: _dropped, ...withoutDeclared } = wire[0];
		expect(readWirePlans([withoutDeclared, wire[1]])).toBeNull();
		expect(readWirePlans([{ ...wire[0], declared: 'yes' }, wire[1]])).toBeNull();
	});
});

describe('plans come only from a manifest the server fetched, offering the chosen item', () => {
	const MASTER = { url: 'https://master.example/dedalo/core/api/v1/json/', code: 'k' };
	const ITEM = {
		url: 'https://master.example/code/7.1.0.zip',
		sha256: 'a'.repeat(64),
		version: '7.1.0',
		release: null,
		channel: null,
	};
	const offered: CodeReleaseItem = {
		version: '7.1.0',
		url: ITEM.url,
		date: '',
		sha256: ITEM.sha256,
	};
	const fetchOf =
		(items: CodeReleaseItem[]): ManifestFetch =>
		async () => ({
			items,
			plans: readWirePlans(JSON.parse(JSON.stringify(wirePlansAbove([7, 0, 1], PLANS, {})))) ?? {
				plans: {},
				data: {},
			},
		});

	test('offered: this tree’s catalog overlaid by the master’s; the target’s data version from the master', async () => {
		const { plans, targetData } = await plansFromMaster(ITEM, [MASTER], fetchOf([offered]));
		expect(plans['7.1.0']?.compat).toBe('incompatible');
		expect(plans['7.1.0']?.steps.map((step) => step.kind)).toEqual(['ontology', 'code', 'data']);
		expect(targetData).toHaveLength(3);
	});

	test('not offered, another sha256, or a URL on no configured master: refused before any plan', async () => {
		const notOffered = await rejected(plansFromMaster(ITEM, [MASTER], fetchOf([])));
		expect(isDedaloError(notOffered) && notOffered.code).toBe('update.refused');
		const otherSha = await rejected(
			plansFromMaster(ITEM, [MASTER], fetchOf([{ ...offered, sha256: 'b'.repeat(64) }])),
		);
		expect(isDedaloError(otherSha) && otherSha.code).toBe('update.refused');
		const foreign = await rejected(
			plansFromMaster(
				{ ...ITEM, url: 'https://elsewhere.example/7.1.0.zip' },
				[MASTER],
				fetchOf([offered]),
			),
		);
		expect(isDedaloError(foreign) && foreign.code).toBe('request.invalid_options');
	});
});

describe('the job’s answer', () => {
	const journalAt = (state: RunState, note: string | null = null) => ({
		...createRunJournal({
			from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
			to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
			plan: [],
		}),
		state,
		note,
	});

	test('CONFIRMED and a restart into the target answer the journal', () => {
		expect(outcomeOrThrow({ state: 'ended', journal: journalAt('CONFIRMED') }).journal.state).toBe(
			'CONFIRMED',
		);
		expect(outcomeOrThrow({ state: 'restarting', journal: journalAt('BACKED_UP') }).state).toBe(
			'restarting',
		);
	});

	test('anything else ended short of a confirm is a failed job carrying the note', () => {
		const failed = thrown(() =>
			outcomeOrThrow({ state: 'ended', journal: journalAt('FAILED_PRE_SWAP', 'swap refused') }),
		);
		expect(isDedaloError(failed) && failed.code).toBe('update.failed');
		expect(isDedaloError(failed) && failed.publicMessage).toContain('swap refused');
		const refused = thrown(() => outcomeOrThrow({ state: 'ended', journal: journalAt('REFUSED') }));
		expect(isDedaloError(refused) && refused.code).toBe('update.refused');
		const rolled = thrown(() =>
			outcomeOrThrow({ state: 'restarting', journal: journalAt('ROLLED_BACK_CODE') }),
		);
		expect(isDedaloError(rolled) && rolled.code).toBe('update.failed');
	});

	test('a pre-swap phase that REFUSED keeps update.refused; after the swap, or a plain throw, it is update.failed', () => {
		const withFailedPhase = (state: RunState, kind: 'code' | 'data', code?: string) => ({
			...journalAt(
				state,
				'7.0.2 code failed: Error. Release checksum mismatch — refusing to install',
			),
			phases: [
				{
					release: '7.0.2',
					step: { kind },
					started: '2026-11-01T00:00:00.000Z',
					finished: '2026-11-01T00:00:01.000Z',
					outcome: 'failed' as const,
					evidence: {
						failure: 'Error. Release checksum mismatch — refusing to install',
						...(code === undefined ? {} : { code }),
					},
				},
			],
		});
		const preSwap = thrown(() =>
			outcomeOrThrow({
				state: 'ended',
				journal: withFailedPhase('FAILED_PRE_SWAP', 'code', 'update.refused'),
			}),
		);
		expect(isDedaloError(preSwap) && preSwap.code).toBe('update.refused');
		expect(isDedaloError(preSwap) && preSwap.publicMessage).toContain('checksum mismatch');
		const plain = thrown(() =>
			outcomeOrThrow({ state: 'ended', journal: withFailedPhase('FAILED_PRE_SWAP', 'code') }),
		);
		expect(isDedaloError(plain) && plain.code).toBe('update.failed');
		const postSwap = thrown(() =>
			outcomeOrThrow({
				state: 'ended',
				journal: withFailedPhase('NEEDS_DB_RESTORE', 'data', 'update.refused'),
			}),
		);
		expect(isDedaloError(postSwap) && postSwap.code).toBe('update.failed');
	});
});

describe('the job’s terminal frame is one the panel reads as a hand-over, not a failure', () => {
	test('the swap’s envelope rides, with the run beside it; resolve_final_frame says updated', () => {
		const base = createRunJournal({
			from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
			to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
			plan: [{ release: '7.0.2', step: { kind: 'code' } }],
		});
		const journal = {
			...base,
			state: 'BACKED_UP' as const,
			phases: [
				{
					release: '7.0.2',
					step: { kind: 'code' as const },
					outcome: 'running' as const,
					started: '2026-10-30T00:00:00Z',
					ended: null,
					evidence: { response: { ok: true, data: { version: '7.0.0', release: '7.0.2' } } },
				},
			],
		} as unknown as Parameters<typeof codeRunAnswer>[0];
		const answer = codeRunAnswer(journal);
		expect(answer).toMatchObject({
			ok: true,
			data: { version: '7.0.0', release: '7.0.2', run_id: base.run_id, state: 'BACKED_UP' },
		});
		expect(resolve_final_frame({}, { is_running: false, data: answer })).toEqual({
			outcome: 'updated',
			version: '7.0.2',
		});
	});
});

describe('did the swap land?', () => {
	const base = createRunJournal({
		from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
		to: { release: '7.0.1', data: '7.0.0', model: '7.0.0', digest: 'd'.repeat(64) },
		plan: [],
	});

	test('the digest decides when the run recorded one — a developer build keeps its version', () => {
		expect(runsTargetTree(base, { release: '7.0.1', digest: 'd'.repeat(64) })).toBe(true);
		expect(runsTargetTree(base, { release: '7.0.1', digest: 'e'.repeat(64) })).toBe(false);
		expect(runsTargetTree(base, { release: '7.0.1', digest: null })).toBe(false);
	});

	test('without a digest, the release identity', () => {
		const { digest: _drop, ...to } = base.to;
		const journal = { ...base, to: { ...to, release: '7.0.2' } };
		expect(runsTargetTree(journal, { release: '7.0.2', digest: null })).toBe(true);
		expect(runsTargetTree(journal, { release: '7.0.1', digest: null })).toBe(false);
	});
});

describe('the client reads every server run state', () => {
	// Record<RunState, …>: a state added to states.ts without a line here fails tsc.
	const ALL: Record<RunState, true> = {
		PLANNED: true,
		PREFLIGHT_OK: true,
		BACKED_UP: true,
		CODE_SWAPPED: true,
		ONTOLOGY_APPLIED: true,
		SCHEMA_APPLIED: true,
		DATA_APPLIED: true,
		ANCILLARY_APPLIED: true,
		VERIFIED: true,
		CONFIRMED: true,
		REFUSED: true,
		FAILED_PRE_SWAP: true,
		ROLLED_BACK_CODE: true,
		NEEDS_DB_RESTORE: true,
		MANUAL: true,
		ABANDONED: true,
	};

	test('non-terminal ⇔ running; every terminal state has its own ending', () => {
		for (const state of Object.keys(ALL) as RunState[]) {
			const progress = run_progress({ state });
			expect([state, progress === 'running']).toEqual([state, !TERMINAL_STATES.has(state)]);
		}
	});
});
