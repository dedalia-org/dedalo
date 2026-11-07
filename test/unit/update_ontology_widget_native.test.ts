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
import {
	type OntologyProgressFrame,
	reportOntologyProgress,
	withOntologyProgress,
} from '../../src/core/ontology/update_progress.ts';
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

/** The door's immediate answer: the background job's {pid, pfile} handle. */
async function submitWidget(options: Record<string, unknown>) {
	const { widget } = await import('../../src/core/area_maintenance/widgets/update_ontology.ts');
	const { SUPERUSER_ID } = await import('../../src/core/security/permissions.ts');
	const door = widget.apiActions?.update_ontology;
	if (door === undefined) throw new Error('update_ontology door is not registered');
	return await door(options, { userId: SUPERUSER_ID } as never);
}

/** Submit, wait for the job, answer its RESULT (what the panel renders). */
async function askWidget(options: Record<string, unknown>) {
	const { mediaJobs } = await import('../../src/core/media/jobs.ts');
	const response = (await submitWidget(options)) as { extend?: { pfile?: string } };
	const id = String(response.extend?.pfile ?? '').slice(0, -'.json'.length);
	const deadline = Date.now() + 10000;
	let status = mediaJobs.status(id);
	while (
		status !== null &&
		(status.status === 'queued' || status.status === 'running') &&
		Date.now() < deadline
	) {
		await Bun.sleep(10);
		status = mediaJobs.status(id);
	}
	if (status?.status !== 'done')
		throw new Error(`update_ontology job ${id} ended ${status?.status}`);
	return status.data as Record<string, unknown>;
}

const ROOT_INFO = { tipo: 'dd1', properties: { version: '7.0.0' } };
const SOURCE = {
	source: 'https://m.example/dedalo/core/api/v1/json/',
	succeeded: true,
	msg: 'imported zzuow',
	problems: [] as string[],
	root_info: ROOT_INFO,
};

describe('update_ontology → startOntologyUpdateRun: the options', () => {
	test('waive_backup + server + files → the pick: source = its url, scope = the files’ TLDs (matrix_dd kept)', async () => {
		const received = interceptRun(journalWith({ sources: [SOURCE] }));
		try {
			await askWidget({
				waive_backup: true,
				server: { url: 'https://m.example/dedalo/core/api/v1/json/', code: 'x' },
				files: [{ tld: 'a' }, { tld: 'matrix_dd' }],
			});
			await askWidget({ server: { url: 'ignored', code: 'localhost' }, files: [{ tld: 'b' }] });
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(received).toEqual([
			{
				waiveBackup: true,
				source: 'https://m.example/dedalo/core/api/v1/json/',
				scope: ['a', 'matrix_dd'],
			},
			{ waiveBackup: false, source: 'localhost', scope: ['b'] },
		]);
	});

	test('no server → unattended, narrowed by the files; an absent waive_backup is false', async () => {
		const received = interceptRun(journalWith({ sources: [SOURCE] }));
		try {
			await askWidget({});
			await askWidget({ waive_backup: 'yes', files: [{ tld: 'a' }] });
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(received).toEqual([{ waiveBackup: false }, { waiveBackup: false, scope: ['a'] }]);
	});

	test('a named server with NO files is still a pick (empty scope), never the unattended set', async () => {
		const received = interceptRun(journalWith({ sources: [SOURCE] }));
		try {
			await askWidget({ server: { url: 'https://m.example/', code: 'x' }, files: [] });
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(received).toEqual([{ waiveBackup: false, source: 'https://m.example/', scope: [] }]);
	});
});

describe('update_ontology: the response the client reads', () => {
	test('the door answers AT ONCE with the background job handle', async () => {
		interceptRun(journalWith({ sources: [SOURCE] }));
		let response: Awaited<ReturnType<typeof submitWidget>>;
		try {
			response = await submitWidget({ files: [{ tld: 'a' }] });
			// let the job finish under the intercept before it is lifted
			await askWidget({});
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(response).toMatchObject({ data: true, extend: { pid: process.pid } });
		expect(String((response as unknown as { extend: { pfile: string } }).extend.pfile)).toEndWith(
			'.json',
		);
	});

	test('a clean phase → the job result {msg, run_id, root_info}: no errors, no census', async () => {
		const journal = journalWith({ sources: [SOURCE] });
		interceptRun(journal);
		let result: Awaited<ReturnType<typeof askWidget>>;
		try {
			result = await askWidget({ files: [{ tld: 'a' }] });
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(result).toEqual({ msg: 'imported zzuow', run_id: journal.run_id, root_info: ROOT_INFO });
	});

	test('problems ride as errors', async () => {
		const journal = journalWith({ sources: [{ ...SOURCE, problems: ['tld_b: missing'] }] });
		interceptRun(journal);
		let result: Awaited<ReturnType<typeof askWidget>>;
		try {
			result = await askWidget({});
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(result).toMatchObject({ msg: 'imported zzuow', errors: ['tld_b: missing'] });
	});

	// Planted where ontology_phase.ts writes it: on the source line of the phase
	// evidence (evidence.sources[].census), in the WC shape (one entry per TLD —
	// WC-2026-10-30-ontology-import-census-restore).
	test('a census in the ontology phase evidence passes through as census', async () => {
		const census = [
			{ tld: 'zzuow', removed: [{ tipo: 'zzuow7', model: 'section', records: 3 }], remodelled: [] },
		];
		const journal = journalWith({ sources: [{ ...SOURCE, census }] });
		interceptRun(journal);
		let result: Awaited<ReturnType<typeof askWidget>>;
		try {
			result = await askWidget({});
		} finally {
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
		expect(result).toEqual({
			msg: 'imported zzuow',
			run_id: journal.run_id,
			root_info: ROOT_INFO,
			census,
		});
	});

	test('the import progress rides the job data while it runs', async () => {
		const { mediaJobs } = await import('../../src/core/media/jobs.ts');
		const journal = journalWith({ sources: [SOURCE] });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		mock.module('../../src/core/update/run/start.ts', () => ({
			...REAL_START,
			startOntologyUpdateRun: async () => {
				reportOntologyProgress('import', 1, 3, 'tld_b');
				await gate;
				return { state: 'ended', journal };
			},
		}));
		try {
			const response = (await submitWidget({})) as unknown as { extend: { pfile: string } };
			const id = response.extend.pfile.slice(0, -'.json'.length);
			const deadline = Date.now() + 10000;
			while (mediaJobs.status(id)?.data === null && Date.now() < deadline) await Bun.sleep(10);
			expect(mediaJobs.status(id)?.data).toEqual({
				msg: 'import tld_b (1/3)',
				progress: { stage: 'import', done: 1, total: 3, tld: 'tld_b' },
			});
			release();
			while (mediaJobs.status(id)?.status !== 'done' && Date.now() < deadline) await Bun.sleep(10);
			expect((mediaJobs.status(id)?.data as { msg: string }).msg).toBe('imported zzuow');
		} finally {
			release();
			mock.module('../../src/core/update/run/start.ts', () => REAL_START);
		}
	});
});

// The progress sink itself (src/core/ontology/update_progress.ts): request-
// scoped, a no-op without a sink (the installer's import reports to no one),
// and two concurrent scopes never see each other's frames.
describe('ontology update progress sink', () => {
	test('no sink: a report is a no-op', () => {
		expect(() => reportOntologyProgress('import', 0, 3, 'tld_a')).not.toThrow();
	});

	test('a scope receives its frames, with the stage facts and a text line', async () => {
		const frames: OntologyProgressFrame[] = [];
		await withOntologyProgress(
			(frame) => frames.push(frame),
			async () => {
				reportOntologyProgress('download', 0, 2, 'tld_a');
				await Promise.resolve();
				reportOntologyProgress('finish', 0, 1);
			},
		);
		expect(frames).toEqual([
			{
				msg: 'download tld_a (0/2)',
				progress: { stage: 'download', done: 0, total: 2, tld: 'tld_a' },
			},
			{ msg: 'finish (0/1)', progress: { stage: 'finish', done: 0, total: 1 } },
		]);
		reportOntologyProgress('import', 1, 2, 'tld_b');
		expect(frames.length).toBe(2);
	});

	test('concurrent scopes are isolated', async () => {
		const a: string[] = [];
		const b: string[] = [];
		const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
		await Promise.all([
			withOntologyProgress(
				(frame) => a.push(frame.progress.tld ?? ''),
				async () => {
					reportOntologyProgress('import', 0, 2, 'a1');
					await tick();
					reportOntologyProgress('import', 1, 2, 'a2');
				},
			),
			withOntologyProgress(
				(frame) => b.push(frame.progress.tld ?? ''),
				async () => {
					await tick();
					reportOntologyProgress('import', 0, 1, 'b1');
				},
			),
		]);
		expect(a).toEqual(['a1', 'a2']);
		expect(b).toEqual(['b1']);
	});
});
