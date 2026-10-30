/**
 * update_ontology WIDGET wiring (update audit 2026-10-29, Phase 2 #16) — where
 * the panel's Update ontology meets the ONTOLOGY-ONLY UPDATE RUN
 * (core/update/run/start.ts startOntologyUpdateRun).
 *
 *  - the options the run receives: `waive_backup:true` → waiveBackup true; the
 *    request's file list NARROWS the run to its TLDs (matrix_dd dropped, it is
 *    not a TLD of the set); no files → no scope at all (the server's whole set);
 *  - the response shape the client reads (render_update_ontology.js):
 *    {data:true, msg, errors?, extend:{run_id, root_info, census?}} — errors
 *    only when the phase reported problems, census only when the phase's
 *    evidence carries one.
 *
 * The run is intercepted (nothing is fetched, imported or journaled); the
 * owned handler is reached through the widget's own gated door, as dispatch
 * reaches it.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { RunJournal } from '../../src/core/update/run/journal.ts';
import * as realStartModule from '../../src/core/update/run/start.ts';

const REAL_START = { ...realStartModule };

afterAll(() => {
	mock.module('../../src/core/update/run/start.ts', () => REAL_START);
});

type StartOptions = Parameters<typeof realStartModule.startOntologyUpdateRun>[1];

/** A CONFIRMED ontology-only journal whose ontology phase carries `evidence`. */
function journalWith(evidence: Record<string, unknown>): RunJournal {
	return {
		format: 1,
		run_id: '20261030T000000Z_0badc0de',
		created: '2026-10-30T00:00:00.000Z',
		updated: '2026-10-30T00:00:00.000Z',
		from: { release: '7.0.0', data: '7.0.0', model: '7.0.0' },
		to: { release: '7.0.0', data: '7.0.0', model: '7.0.0' },
		plan: [{ release: '7.0.0', step: { kind: 'ontology' } }],
		release_plans: {},
		state: 'CONFIRMED',
		phases: [
			{
				release: '7.0.0',
				step: { kind: 'ontology' },
				started: '2026-10-30T00:00:00.000Z',
				finished: '2026-10-30T00:00:01.000Z',
				outcome: 'ok',
				evidence,
			},
		],
		backup: null,
		note: null,
	} as RunJournal;
}

/** Intercept the run: record each options bag, answer with `journal`. */
function interceptRun(journal: RunJournal): StartOptions[] {
	const received: StartOptions[] = [];
	mock.module('../../src/core/update/run/start.ts', () => ({
		...REAL_START,
		startOntologyUpdateRun: async (_principal: unknown, options: StartOptions) => {
			received.push(options);
			return { state: 'ended', journal };
		},
	}));
	return received;
}

async function askWidget(options: Record<string, unknown>) {
	const { widget } = await import('../../src/core/area_maintenance/widgets/update_ontology.ts');
	const { SUPERUSER_ID } = await import('../../src/core/security/permissions.ts');
	const door = widget.apiActions?.update_ontology;
	if (door === undefined) throw new Error('update_ontology door is not registered');
	return await door(options, { userId: SUPERUSER_ID } as never);
}

const ROOT_INFO = { tipo: 'dd1', properties: { version: '7.0.0' } };
const SOURCE = {
	source: 'https://m.example/dedalo/core/api/v1/json/',
	succeeded: true,
	msg: 'imported zza',
	problems: [] as string[],
	root_info: ROOT_INFO,
};

describe('update_ontology → startOntologyUpdateRun: the options', () => {
	test('waive_backup + files → waiveBackup true, scope = the files’ TLDs without matrix_dd', async () => {
		const received = interceptRun(journalWith({ sources: [SOURCE] }));
		try {
			await askWidget({ waive_backup: true, files: [{ tld: 'a' }, { tld: 'matrix_dd' }] });
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(received).toEqual([{ waiveBackup: true, scope: ['a'] }]);
	});

	test('no files → no scope key; an absent waive_backup is false', async () => {
		const received = interceptRun(journalWith({ sources: [SOURCE] }));
		try {
			await askWidget({});
			await askWidget({ waive_backup: 'yes', files: [{ tld: 'matrix_dd' }] });
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(received).toEqual([{ waiveBackup: false }, { waiveBackup: false }]);
		expect(received.every((options) => !('scope' in options))).toBe(true);
	});
});

describe('update_ontology: the response the client reads', () => {
	test('a clean phase → {data:true, msg, extend:{run_id, root_info}}: no errors, no census', async () => {
		const journal = journalWith({ sources: [SOURCE] });
		interceptRun(journal);
		let response: Awaited<ReturnType<typeof askWidget>>;
		try {
			response = await askWidget({ files: [{ tld: 'a' }] });
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(response).toEqual({
			data: true,
			msg: 'imported zza',
			extend: { run_id: journal.run_id, root_info: ROOT_INFO },
		});
		expect('census' in ((response as { extend: object }).extend ?? {})).toBe(false);
	});

	test('problems ride as errors', async () => {
		const journal = journalWith({ sources: [{ ...SOURCE, problems: ['zzb: missing'] }] });
		interceptRun(journal);
		let response: Awaited<ReturnType<typeof askWidget>>;
		try {
			response = await askWidget({});
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(response).toMatchObject({ data: true, msg: 'imported zza', errors: ['zzb: missing'] });
	});

	// Planted where ontology_phase.ts writes it: on the source line of the phase
	// evidence (evidence.sources[].census), in the WC shape (one entry per TLD —
	// WC-2026-10-30-ontology-import-census-restore).
	test('a census in the ontology phase evidence passes through as extend.census', async () => {
		const census = [
			{ tld: 'zza', removed: [{ tipo: 'zza7', model: 'section', records: 3 }], remodelled: [] },
		];
		const journal = journalWith({ sources: [{ ...SOURCE, census }] });
		interceptRun(journal);
		let response: Awaited<ReturnType<typeof askWidget>>;
		try {
			response = await askWidget({});
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect((response as { extend?: Record<string, unknown> }).extend).toEqual({
			run_id: journal.run_id,
			root_info: ROOT_INFO,
			census,
		});
	});
});
