/**
 * tool_identify::cluster — the run's data lang is the REQUEST's when the client
 * names none (T2 B10 review M2).
 *
 * The clusterer never reads request identity itself (cluster.ts: the lang is
 * explicit, like the principal), so the tool server is the boundary that must
 * read it. Before, it forwarded a lang only when the client sent one, and an
 * omitted lang fell through to the install's main data lang deep in the path
 * reader — a request in lg-eng had its criteria compared in lg-spa.
 *
 * The clusterer is replaced by a probe that records the input and stops the run
 * (a `src/` module mock: snapshot spread at import, real exports re-installed in
 * afterAll — mock_isolation_tripwire rule 3). The two request scopes are SPLIT
 * (data ≠ application, swapped), so a lang read from the interface side is red.
 *
 * R2 (owner ruling 2026-11-22): a CLIENT lang is validated before anything runs —
 * malformed (grammar) or well-formed-but-not-declared (the install's data
 * languages, `isInstalledDataLang`) refuses as `request.invalid_options` and the
 * clusterer is never reached; a declared one passes through verbatim. The
 * declared and undeclared probes are DERIVED from the install's own set (floored),
 * never a code this machine happens to configure.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as cluster from '../../src/ai/identify/cluster.ts';
import { isValidLang } from '../../src/core/concepts/ontology.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { installedDataLangs } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { inSplitLane, laneLabel, SPLIT_LANES } from '../helpers/split_request_langs.ts';

const REAL_CLUSTER = { ...cluster };

const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: false };

/** The probe's stop signal: the handler propagates it, the test catches it. */
class ProbeStop extends Error {}

const seen: (string | undefined)[] = [];
mock.module('../../src/ai/identify/cluster.ts', () => ({
	...REAL_CLUSTER,
	clusterRecords: async (input: { lang?: string }) => {
		seen.push(input.lang);
		throw new ProbeStop('probe: input recorded');
	},
}));

const { tool } = await import('../../tools/tool_identify/server/index.ts');

afterAll(() => {
	mock.module('../../src/ai/identify/cluster.ts', () => REAL_CLUSTER);
});

async function callCluster(options: Record<string, unknown>): Promise<unknown> {
	const handler = tool.apiActions.cluster?.handler;
	if (handler === undefined) throw new Error('cluster action missing');
	try {
		await handler({ principal: ADMIN, userId: -1, background: false, options });
	} catch (error) {
		return error;
	}
	return undefined;
}

async function runCluster(options: Record<string, unknown>): Promise<void> {
	// FLOOR: the run reached the clusterer (a refusal before it would prove nothing).
	expect(await callCluster(options)).toBeInstanceOf(ProbeStop);
}

/** A declared data language that is neither lane's data lang (so "the client's wins" is visible). */
const DECLARED = installedDataLangs().find(
	(code) => code !== 'lg-nolan' && !SPLIT_LANES.some((lane) => lane.dataLang === code),
);
/** Well-formed codes this installation does not declare (`all` is grammar, not a language). */
const UNDECLARED = ['lg-zzzq', 'all'].filter((code) => !installedDataLangs().includes(code));
/** Malformed: outside the lang grammar, or not a string at all. */
const MALFORMED: unknown[] = ['', 'spa', 'lg-SPA', "lg-spa' OR 1=1", 42, { lang: 'lg-spa' }];

describe('tool_identify::cluster — the clusterer gets a data lang', () => {
	test('no client lang: the REQUEST data lang, never the interface one', async () => {
		for (const lane of SPLIT_LANES) {
			seen.length = 0;
			await inSplitLane(lane, () => runCluster({ section_tipo: 'test3' }));
			expect(seen, laneLabel(lane)).toEqual([lane.dataLang]);
		}
	});

	test('a client lang still wins', async () => {
		for (const lane of SPLIT_LANES) {
			seen.length = 0;
			await inSplitLane(lane, () => runCluster({ section_tipo: 'test3', lang: DECLARED }));
			expect(seen, laneLabel(lane)).toEqual([DECLARED]);
		}
	});
});

describe('tool_identify::cluster — a client lang is validated before anything runs (R2)', () => {
	test('floor: the probes are what they claim', () => {
		expect(typeof DECLARED).toBe('string');
		expect(UNDECLARED).toEqual(['lg-zzzq', 'all']);
		for (const code of UNDECLARED) expect(isValidLang(code), code).toBe(true);
		for (const raw of MALFORMED) {
			if (typeof raw === 'string') expect(isValidLang(raw), raw).toBe(false);
		}
	});

	test('malformed → request.invalid_options, the clusterer never called', async () => {
		for (const raw of MALFORMED) {
			seen.length = 0;
			const thrown = await inSplitLane(SPLIT_LANES[0] as (typeof SPLIT_LANES)[0], () =>
				callCluster({ section_tipo: 'test3', lang: raw }),
			);
			expect(thrown, JSON.stringify(raw)).toBeInstanceOf(DedaloError);
			expect((thrown as DedaloError).code, JSON.stringify(raw)).toBe('request.invalid_options');
			// The GRAMMAR refused it, not the membership check (which would also refuse
			// a malformed string — the reason must name what is wrong).
			expect((thrown as DedaloError).publicMessage, JSON.stringify(raw)).toBe(
				'lang is not a language code',
			);
			expect(seen, JSON.stringify(raw)).toEqual([]);
		}
		// FLOOR: the same probe DOES record a declared lang in this lane, so the
		// emptiness above is the refusal, not a probe that sees nothing.
		await inSplitLane(SPLIT_LANES[0] as (typeof SPLIT_LANES)[0], () =>
			runCluster({ section_tipo: 'test3', lang: DECLARED }),
		);
		expect(seen).toHaveLength(1);
	});

	test('well-formed but not a declared data language → refused, the clusterer never called', async () => {
		for (const code of UNDECLARED) {
			seen.length = 0;
			const thrown = await inSplitLane(SPLIT_LANES[0] as (typeof SPLIT_LANES)[0], () =>
				callCluster({ section_tipo: 'test3', lang: code }),
			);
			expect(thrown, code).toBeInstanceOf(DedaloError);
			expect((thrown as DedaloError).code, code).toBe('request.invalid_options');
			expect((thrown as DedaloError).publicMessage, code).toBe(
				`lang '${code}' is not a data language of this installation`,
			);
			expect(seen, code).toEqual([]);
		}
		// FLOOR: the same probe DOES record a declared lang in this lane, so the
		// emptiness above is the refusal, not a probe that sees nothing.
		await inSplitLane(SPLIT_LANES[0] as (typeof SPLIT_LANES)[0], () =>
			runCluster({ section_tipo: 'test3', lang: DECLARED }),
		);
		expect(seen).toHaveLength(1);
	});
});
