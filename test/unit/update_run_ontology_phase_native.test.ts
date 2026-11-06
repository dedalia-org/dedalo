/**
 * THE RUN'S ONTOLOGY PHASE (update audit 2026-10-29, design §5; D-6, D-8) —
 * src/core/update/run/ontology_phase.ts. The run computes the request itself:
 *
 *  - only active, admissible shared TLDs a source serves — never a local TLD,
 *    never the local overrides TLD (localontology), never an inactive one; matrix_dd from the source
 *    that declares it;
 *  - several sources: each serves only its declared `tlds`;
 *  - a `min` precondition the source cannot meet fails the phase before any
 *    update; an unreadable manifest or a failed door fails it; no source = fail.
 */

import { describe, expect, test } from 'bun:test';
import type { ManifestResult } from '../../src/core/ontology/ontology_manifest.ts';
import { createRunJournal } from '../../src/core/update/run/journal.ts';
import { ontologyRunAnswer, runOntologyPhase } from '../../src/core/update/run/ontology_phase.ts';

const ORIGIN_A = 'https://a.example';
const ORIGIN_B = 'https://b.example';

const DIGEST = 'a'.repeat(64);

/** A master's manifest; every file digested (an unattended run requires it — #14) unless `digests: false`. */
function manifestOf(
	origin: string,
	tlds: string[],
	version = '7.0.0',
	digests = true,
): ManifestResult {
	return {
		ok: true,
		version,
		ontologies: tlds.map((tld) => ({
			tld,
			name: tld,
			name_data: null,
			typology_id: null,
			typology_name: null,
			dependencies: null,
			url: `${origin}/${tld}.copy.gz`,
			...(digests ? { sha256: DIGEST } : {}),
		})),
		matrixDdUrl: `${origin}/matrix_dd.copy.gz`,
		...(digests ? { matrixDdSha256: DIGEST } : {}),
		warnings: [],
	};
}

function phase(options: {
	servers: { url: string; code: string; tlds?: string[] }[];
	manifests: Record<string, ManifestResult>;
	active?: string[];
	min?: string;
	fail?: string;
	scope?: string[];
	/** The install is itself an ontology server (IS_AN_ONTOLOGY_SERVER). */
	master?: boolean;
}) {
	const calls: { url: string; tlds: string[] }[] = [];
	const run = runOntologyPhase(
		{ kind: 'ontology', ...(options.min ? { min: options.min } : {}) },
		-1,
		{
			catalog: { servers: options.servers, isOntologyServer: options.master === true },
			...(options.scope === undefined ? {} : { scope: options.scope }),
			activeTlds: options.active ?? ['zzupopa', 'zzupopb', 'localontology'],
			readManifest: async (source) =>
				options.manifests[source.server.url] ?? { ok: false, reason: 'unreachable (HTTP 404)' },
			update: async (raw) => {
				const request = raw as { server: { url: string }; files: { tld: string }[] };
				calls.push({ url: request.server.url, tlds: request.files.map((file) => file.tld) });
				const ok = options.fail !== request.server.url;
				return {
					ok,
					msg: ok ? 'OK. Request done successfully' : 'Error. Import failed',
					errors: ok ? [] : ['planted'],
					root_info: { term: 'Dédalo' },
				};
			},
		},
	);
	return { run, calls };
}

describe('the run computes the ontology request itself', () => {
	test('one undeclared source: every active admissible TLD it serves + matrix_dd; never local, never inactive', async () => {
		const { run, calls } = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests: {
				[`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, [
					'zzupopa',
					'zzupopb',
					'zzupopx',
					'localontology',
				]),
			},
		});
		expect((await run).outcome).toBe('ok');
		expect(calls).toEqual([{ url: `${ORIGIN_A}/api/`, tlds: ['zzupopa', 'zzupopb', 'matrix_dd'] }]);
	});

	test('several sources: each only its declared TLDs; matrix_dd only where declared', async () => {
		const { run, calls } = phase({
			servers: [
				{ url: `${ORIGIN_A}/api/`, code: 'k', tlds: ['zzupopa', 'matrix_dd'] },
				{ url: `${ORIGIN_B}/api/`, code: 'k', tlds: ['zzupopb'] },
			],
			manifests: {
				[`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa', 'zzupopb']),
				[`${ORIGIN_B}/api/`]: manifestOf(ORIGIN_B, ['zzupopa', 'zzupopb']),
			},
		});
		expect((await run).outcome).toBe('ok');
		expect(calls).toEqual([
			{ url: `${ORIGIN_A}/api/`, tlds: ['zzupopa', 'matrix_dd'] },
			{ url: `${ORIGIN_B}/api/`, tlds: ['zzupopb'] },
		]);
	});

	test('a min the source cannot meet fails before any update', async () => {
		const { run, calls } = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests: { [`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa'], '7.0.0') },
			min: '7.1.0',
		});
		const result = await run;
		expect(result.outcome).toBe('failed');
		expect(JSON.stringify(result.evidence)).toContain('needs 7.1.0 first');
		expect(calls).toEqual([]);
		// Positive control: the same source with a min it meets DOES reach the door,
		// so the empty `calls` above is the min refusing, not a seam that never records.
		const control = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests: { [`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa'], '7.0.0') },
			min: '7.0.0',
		});
		await control.run;
		expect(control.calls.length).toBeGreaterThan(0);
	});

	test('an unreadable manifest, a failed door, no source at all: each fails the phase', async () => {
		const unreadable = phase({ servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }], manifests: {} });
		expect((await unreadable.run).outcome).toBe('failed');
		const door = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests: { [`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa']) },
			fail: `${ORIGIN_A}/api/`,
		});
		expect((await door.run).outcome).toBe('failed');
		const none = phase({ servers: [], manifests: {} });
		expect((await none.run).outcome).toBe('failed');
	});
});

describe('an ontology SERVER promotes from remote providers (master7 pulling beta7)', () => {
	const BETA = `${ORIGIN_B}/api/`;
	const readManifest = {
		[BETA]: manifestOf(ORIGIN_B, ['zzupopa', 'zzupopb']),
	};

	test('no entries: its own export is the source, as before (localhost)', async () => {
		const sources: string[] = [];
		const result = await runOntologyPhase({ kind: 'ontology' }, -1, {
			catalog: { servers: [], isOntologyServer: true },
			activeTlds: ['zzupopa'],
			readManifest: async (source) => {
				sources.push(source.server.code);
				return manifestOf('http://localhost', ['zzupopa']);
			},
			update: async () => ({ ok: true, msg: 'OK', errors: [] }),
		});
		expect(result.outcome).toBe('ok');
		expect(sources).toEqual(['localhost']);
	});

	test('entries with tlds: ONLY those TLDs are pulled from the remote; own export is no source; matrix_dd not unless listed', async () => {
		const { run, calls } = phase({
			master: true,
			servers: [{ url: BETA, code: 'beta-code', tlds: ['zzupopa'] }],
			manifests: readManifest,
		});
		expect((await run).outcome).toBe('ok');
		// zzupopb is in the remote manifest and active, but not listed: untouched
		expect(calls).toEqual([{ url: BETA, tlds: ['zzupopa'] }]);
	});

	test('matrix_dd is imported when an entry lists it', async () => {
		const { run, calls } = phase({
			master: true,
			servers: [{ url: BETA, code: 'beta-code', tlds: ['zzupopa', 'matrix_dd'] }],
			manifests: readManifest,
		});
		expect((await run).outcome).toBe('ok');
		expect(calls).toEqual([{ url: BETA, tlds: ['zzupopa', 'matrix_dd'] }]);
	});

	test('an entry without tlds (absent or empty) is CODE-ONLY: never refused, never a source; all code-only keeps localhost', async () => {
		for (const tlds of [undefined, []] as (string[] | undefined)[]) {
			const sources: string[] = [];
			const result = await runOntologyPhase({ kind: 'ontology' }, -1, {
				catalog: {
					servers: [{ url: BETA, code: 'client-code', ...(tlds === undefined ? {} : { tlds }) }],
					isOntologyServer: true,
				},
				activeTlds: ['zzupopa'],
				readManifest: async (source) => {
					sources.push(source.server.code);
					return manifestOf('http://localhost', ['zzupopa']);
				},
				update: async () => ({ ok: true, msg: 'OK', errors: [] }),
			});
			expect(result.outcome).toBe('ok');
			// the remote is never read; the server's own export is the source, as before
			expect(sources).toEqual(['localhost']);
		}
	});

	test('mixed list: providers only for the tlds entries; the code-only entry is not read, localhost is dropped', async () => {
		const { run, calls } = phase({
			master: true,
			servers: [
				{ url: `${ORIGIN_A}/api/`, code: 'client-code' },
				{ url: BETA, code: 'beta-code', tlds: ['zzupopa'] },
			],
			manifests: readManifest,
		});
		expect((await run).outcome).toBe('ok');
		expect(calls).toEqual([{ url: BETA, tlds: ['zzupopa'] }]);
	});

	test('a non-server install with an entry without tlds is unchanged (takes everything)', async () => {
		const { run, calls } = phase({
			servers: [{ url: BETA, code: 'k' }],
			manifests: readManifest,
		});
		expect((await run).outcome).toBe('ok');
		expect(calls[0]?.tlds).toEqual(['zzupopa', 'zzupopb', 'matrix_dd']);
	});
});

describe('the run requires file digests (#14)', () => {
	test('a source that publishes none for a selected file is refused before the door', async () => {
		const none = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests: { [`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa'], '7.0.0', false) },
		});
		const result = await none.run;
		expect(result.outcome).toBe('failed');
		expect(String(result.evidence.summary)).toContain(
			'publishes no file digest for zzupopa, matrix_dd',
		);
		expect(none.calls).toEqual([]); // the door never ran
	});
});

describe('no ontology source configured', () => {
	const none = (sourceOptional?: boolean) =>
		runOntologyPhase({ kind: 'ontology' }, -1, {
			catalog: { servers: [], isOntologyServer: false },
			...(sourceOptional === undefined ? {} : { sourceOptional }),
			update: async () => {
				throw new Error('no source: the door is never reached');
			},
		});

	test('a declared step (or the ontology-only run) fails: it needs a source', async () => {
		expect(await none()).toEqual({
			outcome: 'failed',
			evidence: { summary: 'no ontology source is configured' },
		});
	});

	test('a release’s default step in a code run is skipped, recorded — the code update goes on', async () => {
		expect(await none(true)).toEqual({
			outcome: 'ok',
			evidence: { skipped: 'no ontology source is configured' },
		});
	});
});

describe('what the run and the panel are told', () => {
	test('a failed source names itself and the door’s sentences in the summary (the run’s note)', async () => {
		const door = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests: { [`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa']) },
			fail: `${ORIGIN_A}/api/`,
		});
		const result = await door.run;
		expect(result.evidence.summary).toBe(`${ORIGIN_A}/api/: Error. Import failed — planted`);
	});

	test('a confirmed run answers the door’s sentence and the dd1 read-back', async () => {
		const ok = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests: { [`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa']) },
		});
		const result = await ok.run;
		const journal = {
			...createRunJournal({
				from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
				to: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
				plan: [{ release: '7.0.1', step: { kind: 'ontology' } }],
			}),
			phases: [
				{
					release: '7.0.1',
					step: { kind: 'ontology' as const },
					started: '',
					finished: '',
					outcome: 'ok' as const,
					evidence: result.evidence,
				},
			],
		};
		expect(ontologyRunAnswer(journal)).toEqual({
			msg: 'OK. Request done successfully',
			errors: [],
			rootInfo: { term: 'Dédalo' },
			census: null, // the stub door reports no census
		});
	});
});

describe('the operator’s narrowing (an ontology-only run’s scope)', () => {
	test('narrows to the named TLDs (+ matrix_dd); never adds one outside the server’s set', async () => {
		const manifests = {
			[`${ORIGIN_A}/api/`]: manifestOf(ORIGIN_A, ['zzupopa', 'zzupopb', 'zzupopx']),
		};
		const narrowed = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests,
			scope: ['zzupopb'],
		});
		await narrowed.run;
		expect(narrowed.calls).toEqual([{ url: `${ORIGIN_A}/api/`, tlds: ['zzupopb', 'matrix_dd'] }]);
		const widened = phase({
			servers: [{ url: `${ORIGIN_A}/api/`, code: 'k' }],
			manifests,
			scope: ['zzupopx', 'localontology'],
		});
		await widened.run;
		expect(widened.calls).toEqual([{ url: `${ORIGIN_A}/api/`, tlds: ['matrix_dd'] }]);
	});
});
