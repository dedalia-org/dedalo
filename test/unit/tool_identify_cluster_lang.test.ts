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
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as cluster from '../../src/ai/identify/cluster.ts';
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

async function runCluster(options: Record<string, unknown>): Promise<void> {
	const handler = tool.apiActions.cluster?.handler;
	if (handler === undefined) throw new Error('cluster action missing');
	let thrown: unknown;
	try {
		await handler({ principal: ADMIN, userId: -1, background: false, options });
	} catch (error) {
		thrown = error;
	}
	// FLOOR: the run reached the clusterer (a refusal before it would prove nothing).
	expect(thrown).toBeInstanceOf(ProbeStop);
}

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
			await inSplitLane(lane, () => runCluster({ section_tipo: 'test3', lang: 'lg-cat' }));
			expect(seen, laneLabel(lane)).toEqual(['lg-cat']);
		}
	});
});
