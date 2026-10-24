/**
 * R1 gate: tool_transcription LOCAL half + the remote-ASR seam. The core builds
 * the audio_tr WAV from a scratch AV original with the REAL ffmpeg binary, is
 * idempotent, and hard-deletes. The tool module loads with the full action
 * surface (permission: null → imperative media_ddo gates). The remote seam is
 * exercised through stubs: status-poll body construction, SSRF fail-closed,
 * segment→TC-text conversion (seg2tc parity), and the bounded completion poll
 * with an injected save. Full tool_request→DB drive is ledgered (media not
 * synced here), matching the media_tools.test.ts convention.
 */
// Migrated to the generic `test` TLD 2026-08-19: the media identity lives in this file's
// own scratch media root and the id-1-slot drive now writes to the `test3` playground
// (matrix_test), so the tipos only have to be real nodes of the right model — they now
// name generic `test` ones (test94 = component_av, test17 = component_text_area).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ok } from '../../src/core/errors/convert.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { mediaJobs } from '../../src/core/media/jobs.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import {
	deleteTranscribableAudio,
	ensureTranscribableAudio,
	transcribableAudioLocation,
} from '../../src/core/media/tools/transcription.ts';
import { secondsToTc } from '../../src/core/resolve/tr_marks.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getToolConfig, resetConfigCache } from '../../src/core/tools/config.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import {
	babelTranscriberStatusProvider,
	buildTranscriberStatusBody,
	hasExistingTranscription,
	mapTranscriberEngine,
	pollTranscriptionCompletion,
	resolveTranscriberConfig,
	resolveTranscriberProvider,
	resolveTranscriberStatusProvider,
	segmentsToTcText,
	type TranscriberStatusRequest,
} from '../../src/core/tools/transcription_asr.ts';
import {
	backgroundRepairModel,
	buildModelSourcesPayload,
	releaseModelRepairLock,
	repairModelAction,
	type ScheduleRepair,
	tool,
} from '../../tools/tool_transcription/server/index.ts';
import { issuePollHandle } from '../../tools/tool_transcription/server/poll_handle.ts';
import { mustGet } from '../helpers/assert.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { removeScratchDir, scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('transcription');
const av = mediaTypeOf('component_av')!;
const HAVE_FFMPEG = existsSync(config.media.binaries.ffmpeg);
const identity: MediaIdentity = {
	componentTipo: 'test94',
	sectionTipo: 'test3',
	sectionId: 7,
	lang: null,
};
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };

/** Make a scratch AV original: a short mp4 with an audio stream (sine tone). */
async function makeAvOriginal(): Promise<void> {
	const abs = `${ROOT}/av/original/test94_test3_7.mp4`;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'sine=frequency=440:duration=1',
			'-c:a',
			'aac',
			abs,
		],
		{ nice: false },
	);
}

beforeAll(() => resetMediaRoot(ROOT));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('tool_transcription local core', () => {
	test.if(HAVE_FFMPEG)(
		'ensureTranscribableAudio builds the audio_tr WAV from the AV original',
		async () => {
			await makeAvOriginal();
			const rel = await ensureTranscribableAudio(av, identity, pathOpts);
			expect(rel).toBe('/av/audio_tr/test94_test3_7.wav');
			expect(existsSync(transcribableAudioLocation(av, identity, pathOpts).absolutePath)).toBe(
				true,
			);
		},
	);

	test.if(HAVE_FFMPEG)('ensure is idempotent — reuses the existing WAV', async () => {
		const rel = await ensureTranscribableAudio(av, identity, pathOpts);
		expect(rel).toBe('/av/audio_tr/test94_test3_7.wav');
	});

	test.if(HAVE_FFMPEG)('delete removes it (true), then is a no-op (false)', () => {
		expect(deleteTranscribableAudio(av, identity, pathOpts)).toBe(true);
		expect(existsSync(transcribableAudioLocation(av, identity, pathOpts).absolutePath)).toBe(false);
		expect(deleteTranscribableAudio(av, identity, pathOpts)).toBe(false);
	});

	test('ensure rejects a non-av component', async () => {
		const image = mediaTypeOf('component_image')!;
		await expect(ensureTranscribableAudio(image, identity, pathOpts)).rejects.toThrow(
			/component_av/,
		);
	});
});

describe('tool_transcription module', () => {
	test('loads with the full action surface', async () => {
		const loaded = await getLoadedTool('tool_transcription');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions).sort()).toEqual([
			'automatic_transcription',
			'build_subtitles_file',
			'check_server_transcriber_status',
			'create_transcribable_audio_file',
			'delete_transcribable_audio_file',
			// Admin-gated in-UI model seeding (validated against the catalog).
			'download_model',
			// Where the BROWSER engine may load its model from. The browser cannot
			// read the install's configuration, so the operator's model-store and
			// hub-fallback settings would otherwise be inert.
			'get_model_sources',
			// Admin-gated: discard and re-fetch the files that fail their check.
			'repair_model',
			// Admin-gated: resolve an `unverified` model into `ready`/`incomplete`.
			'verify_model',
		]);
		// permission: null → each handler gates imperatively against its ddo.
		expect(
			mustGet(actions.create_transcribable_audio_file, 'create_transcribable_audio_file')
				.permission,
		).toBeNull();
		expect(
			mustGet(actions.automatic_transcription, 'automatic_transcription').permission,
		).toBeNull();
		expect(
			mustGet(actions.check_server_transcriber_status, 'check_server_transcriber_status')
				.permission,
		).toBeNull();
		expect(mustGet(actions.build_subtitles_file, 'build_subtitles_file').permission).toBeNull();
	});

	test('the background actions are allowlisted but NOT client-routable', async () => {
		const loaded = await getLoadedTool('tool_transcription');
		expect(loaded!.module.backgroundRunnable).toEqual([
			'check_background_transcriber_status',
			'background_download_model',
			'background_repair_model',
		]);
		// absent from apiActions — an action not in the map is unroutable.
		expect(loaded!.module.apiActions.check_background_transcriber_status).toBeUndefined();
		expect(loaded!.module.apiActions.background_download_model).toBeUndefined();
		expect(loaded!.module.apiActions.background_repair_model).toBeUndefined();
	});

	test('download_model refuses everyone but a global administrator', async () => {
		// The action makes the SERVER fetch ~1 GB from the public hub and write it
		// to disk — an operator act. The refusal must run before any catalog read.
		const loaded = await getLoadedTool('tool_transcription');
		const handler = loaded!.module.apiActions.download_model!.handler;
		const refusal = await refusalOf(
			handler({
				principal: stubPrincipal, // not an admin
				userId: 7,
				options: { model: 'onnx-community/whisper-large-v3-turbo' },
				background: false,
			}),
		);
		expect(refusal.code).toBe('perm.denied');
	});

	test('download_model refuses a model that is not in the catalog', async () => {
		// The id becomes a hub URL path and a store directory — free-form input
		// would download arbitrary repos or write outside the intended folder.
		const loaded = await getLoadedTool('tool_transcription');
		const handler = loaded!.module.apiActions.download_model!.handler;
		const admin: Principal = { userId: 1, isGlobalAdmin: true, isDeveloper: false };
		const refusal = await refusalOf(
			handler({
				principal: admin,
				userId: 1,
				options: { model: '../../evil/path' },
				background: false,
			}),
		);
		expect(refusal.code).toBe('tool.unsupported_target');
		expect(refusal.publicMessage).toContain('not in the transcriber catalog');
	});
});

const stubPrincipal: Principal = { userId: 7, isGlobalAdmin: false, isDeveloper: false };

/** The envelope v2 failure body (ERRORS_SPEC §3) — what the wire really carries. */
interface WireFailure {
	ok: false;
	request_id: string;
	error: { code: string; message: string; label_key: string; category: string };
}

/**
 * The REAL envelope a failing poll puts on the wire, harvested once.
 *
 * The honesty branch needs the poll to actually REACH the provider, which needs
 * DEDALO_MEDIA_EXPORT_BASE (unset on a dev box, where the URL builder refuses
 * first). `config` freezes at import, so overlay it in a child — same pattern as
 * media_export_base.test.ts. The uri stays loopback, so the SSRF guard answers
 * with a refusal (`ok:false` + the registered code) and no network call.
 * Memoized: the client-coupling test feeds this exact object to the browser
 * poller (through the same normalization data_manager applies).
 */
let failureEnvelope: WireFailure | null = null;
function liveFailureEnvelope(): WireFailure {
	if (failureEnvelope !== null) return failureEnvelope;
	const script = [
		"const {getLoadedTool}=await import('./src/core/tools/loader.ts');",
		"const t=await getLoadedTool('tool_transcription');",
		"const {toErrorEnvelope}=await import('./src/core/errors/index.ts');",
		// The poll accepts only a handle THIS process issued (poll_handle.ts), bound
		// to the caller and the record — minted here, in the child that polls.
		"const {issuePollHandle}=await import('./tools/tool_transcription/server/poll_handle.ts');",
		"const pid=issuePollHandle({pid:4321,engine:'babel_transcriber',userId:-1,sectionTipo:'test3',componentTipo:'test94',sectionId:1});",
		'try{',
		'const r=await t.module.apiActions.check_server_transcriber_status.handler({',
		'principal:{userId:-1,isGlobalAdmin:true,isDeveloper:true},userId:-1,background:false,',
		"options:{media_ddo:{component_tipo:'test94',section_tipo:'test3',section_id:1},",
		"transcriber_engine:'babel_transcriber',pid}});",
		'console.log(JSON.stringify(r));',
		// The handler REFUSES BY THROWING now (ERRORS_SPEC §4); the wire body the
		// browser reads is what the chokepoint's converter makes of it, so the
		// probe converts it exactly the same way.
		"}catch(e){console.log(JSON.stringify(toErrorEnvelope(e,{requestId:'probe'}).body));}",
	].join('');
	const probe = Bun.spawnSync(
		['bun', '--preload', './test/preload/component_registry.ts', '-e', script],
		{
			cwd: `${import.meta.dir}/../..`,
			env: {
				...process.env,
				DEDALO_DATABASE_CONN: 'dedalo7ts_test',
				DEDALO_MEDIA_EXPORT_BASE: 'http://media.example.org/dedalo/media',
			},
		},
	);
	const line = probe.stdout.toString().trim().split('\n').pop() ?? '{}';
	failureEnvelope = JSON.parse(line) as WireFailure;
	return failureEnvelope;
}

describe('check_server_transcriber_status handler', () => {
	test('denies fail-closed on an invalid media_ddo record target (READ gate)', async () => {
		const loaded = await getLoadedTool('tool_transcription');
		const handler = loaded!.module.apiActions.check_server_transcriber_status!.handler;
		const refusal = await refusalOf(
			handler({
				principal: stubPrincipal,
				userId: 7,
				options: {
					media_ddo: { component_tipo: 'test94', section_tipo: 'bad tipo!', section_id: 1 },
					transcriber_engine: 'babel_transcriber',
					pid: 123,
				},
				background: false,
			}),
		);
		// The write door (closure Step 3) refuses an unusable target at its GRAMMAR
		// step, before any permission or record read.
		expect(refusal.code).toBe('request.invalid');
		expect(refusal.message).toContain('section_tipo is not a valid tipo');
	});

	test('no media_ddo at all is a GATE refusal (the gate runs first, unconditionally)', async () => {
		const loaded = await getLoadedTool('tool_transcription');
		const handler = loaded!.module.apiActions.check_server_transcriber_status!.handler;
		const refusal = await refusalOf(
			handler({ principal: stubPrincipal, userId: 7, options: {}, background: false }),
		);
		expect(refusal.code).toBe('request.invalid');
	});

	test('reports the missing required parameters past the gate (PHP message shape)', async () => {
		// The superuser passes the READ gate on a well-formed media_ddo, so what is
		// left to refuse is the missing pid. The engine is NOT required: the job
		// polled — its id AND its engine — is the poll handle's (poll_handle.ts).
		const loaded = await getLoadedTool('tool_transcription');
		const handler = loaded!.module.apiActions.check_server_transcriber_status!.handler;
		const superuser: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
		const refusal = await refusalOf(
			handler({
				principal: superuser,
				userId: -1,
				options: { media_ddo: { component_tipo: 'test94', section_tipo: 'test3', section_id: 1 } },
				background: false,
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		// A public-disclosure code, so the sentence still reaches the wire.
		expect(refusal.publicMessage).toBe('Missing required parameters: pid');
	});
});

/**
 * The READ-gated poll, driven end to end against a SEEDED dd996 transcriber
 * config. Three regressions in one drive (audit 2026-07-28):
 *  1. the entry list was read at `config.transcriber_config.value`, a shape
 *     getToolConfig never emits — so BOTH remote-ASR actions were dead, always
 *     answering "Transcriber config (uri/key) is not defined";
 *  2. the poll called ensureAudioQuality, i.e. a level-1 READ action could fire
 *     an ffmpeg transcode and write a media file (PHP only builds the URL);
 *  3. an unreachable/blocked transcriber came back as a SUCCESS envelope with
 *     no status — a dead ASR server read as success (and the client maps a
 *     status-less payload to its `default:` "Process done" branch).
 * The seeded uri is loopback, so the SSRF guard trips: no network is touched.
 */
describe('check_server_transcriber_status against a configured transcriber', () => {
	const SCRATCH_SECTION_ID = 990041;
	// SUPERUSER_ID: the gate is not the subject here — the poll's behaviour is.
	const adminPrincipal: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

	beforeAll(async () => {
		await sql`DELETE FROM matrix_tools WHERE section_tipo = 'dd996' AND section_id = ${SCRATCH_SECTION_ID}`;
		await sql`
			INSERT INTO matrix_tools (section_id, section_tipo, string, misc)
			VALUES (
				${SCRATCH_SECTION_ID},
				'dd996',
				${'{"dd1326":[{"id":1,"value":"tool_transcription"}]}'}::text::jsonb,
				${'{"dd999":[{"id":1,"value":{"transcriber_config":[{"name":"babel_transcriber","uri":"http://127.0.0.1:9/api/","key":"scratch-key"}]}}]}'}::text::jsonb
			)`;
		resetConfigCache();
	});
	afterAll(async () => {
		await sql`DELETE FROM matrix_tools WHERE section_tipo = 'dd996' AND section_id = ${SCRATCH_SECTION_ID}`;
		resetConfigCache();
	});

	test('the seeded config resolves through the real getToolConfig shape', async () => {
		expect(
			resolveTranscriberConfig(await getToolConfig('tool_transcription'), 'babel_transcriber'),
		).toEqual({ uri: 'http://127.0.0.1:9/api/', key: 'scratch-key' });
	});

	test('never transcodes, and never reports a failed poll as OK', async () => {
		const loaded = await getLoadedTool('tool_transcription');
		const handler = loaded!.module.apiActions.check_server_transcriber_status!.handler;
		const refusal = await refusalOf(
			handler({
				principal: adminPrincipal,
				userId: -1,
				options: {
					media_ddo: { component_tipo: 'test94', section_tipo: 'test3', section_id: 1 },
					transcriber_engine: 'babel_transcriber',
					pid: issuePollHandle({
						pid: 4321,
						engine: 'babel_transcriber',
						userId: -1,
						sectionTipo: 'test3',
						componentTipo: 'test94',
						sectionId: 1,
					}),
				},
				background: false,
			}),
		);
		// It got PAST the config lookup (regression 1) and never asked for the
		// audio quality to be BUILT (regression 2): 'AV original file not found'
		// is ensureAudioQuality's error and can only surface here if the read path
		// tries to transcode. `message` is the LOG sentence the throw carried.
		expect(refusal.message).not.toContain('Transcriber config');
		expect(refusal.message).not.toContain('AV original file not found');
		// And it did not dress a failure up as a success (regression 3): the
		// loopback uri is refused by the SSRF guard (or, when
		// DEDALO_MEDIA_EXPORT_BASE is unset, the URL builder refuses first) —
		// either way this call cannot succeed, and a REFUSAL is a throw now, not a
		// body that could be mistaken for one.
		expect(refusal.code).toBe('tool.dependency_unavailable');
	});

	/**
	 * The honesty branch needs the poll to actually REACH the provider, which
	 * needs DEDALO_MEDIA_EXPORT_BASE (unset on a dev box, where the URL builder
	 * refuses first). `config` freezes at import, so overlay it in a child —
	 * same pattern as media_export_base.test.ts. The uri stays loopback, so the
	 * SSRF guard answers `{result:false,…}` with no network call.
	 */
	test('a provider failure is reported as a failure, never as OK', () => {
		const response = liveFailureEnvelope();
		// Envelope v2: `ok:false` is the fact and `error.code` the registered code
		// (the raw 'invalid transcriber URL' sentence is LOG-only — the code's
		// disclosure is 'operator'). The retired `result`/`errors` mirror is gone.
		expect(response.ok).toBe(false);
		expect('result' in response).toBe(false);
		expect(response.error.code).toBe('tool.dependency_unavailable');
	});
});

/**
 * CLIENT half of the outage-honesty contract (audit 2026-07-28).
 *
 * The server now answers a dead/blocked ASR server with an `ok:false` envelope,
 * but the browser is what the user reads: `get_server_status()` in
 * tools/tool_transcription/js/render_tool_transcription.js switches on the
 * payload's `status`, and a status-less envelope used to fall through to
 * `case 3: default:` — rendering "Process done" AND deleting the stored pid.
 * A dead transcriber therefore looked like a finished transcription and threw
 * away the only handle to the running job.
 *
 * The client module is served over HTTP (its imports resolve to /dedalo/core/…,
 * which does not exist on disk), so it cannot be imported directly. This
 * harness loads the REAL source text, strips the import block, and re-exports
 * the module-scoped poller — every assertion below runs the shipped code.
 */
const CLIENT_SOURCE = `${import.meta.dir}/../../tools/tool_transcription/js/render_tool_transcription.js`;

interface StubNode {
	textContent: string;
	classList: {
		add: (c: string) => void;
		remove: (c: string) => void;
		contains: (c: string) => boolean;
	};
}
function stubNode(...initial: string[]): StubNode {
	const classes = new Set<string>(initial);
	return {
		textContent: '',
		classList: {
			add: (c: string) => {
				classes.add(c);
			},
			remove: (c: string) => {
				classes.delete(c);
			},
			contains: (c: string) => classes.has(c),
		},
	};
}

/**
 * The tool's ONE status panel (tools/…/js/render_transcription_status.js), stubbed.
 *
 * The poller used to write into a `status_container` div and toggle
 * error/processing/hide classes on it; the panel replaced that node because its
 * error writer never removed the `hide` class, so failures raised before a run
 * were invisible. What the assertions below check is unchanged — the user must
 * not read "Process done" for a failure — only WHERE it is now written.
 */
interface StubPanel {
	reports: { severity?: string; message?: string }[];
	/** everything shown, in order — a report's message or a progress line */
	shown: string[];
	report: (input: { severity?: string; message?: string }) => void;
	progress: (text: string) => void;
	clear: () => void;
	readiness: (lines: unknown[]) => void;
	node: unknown;
}
function stubPanel(): StubPanel {
	const reports: { severity?: string; message?: string }[] = [];
	const shown: string[] = [];
	return {
		reports,
		shown,
		report: (input) => {
			reports.push(input);
			shown.push(input?.message ?? '');
		},
		progress: (text: string) => {
			shown.push(text);
		},
		clear: () => {
			reports.length = 0;
			shown.length = 0;
		},
		readiness: () => {},
		node: null,
	};
}
/** What the user reads: the last thing the panel was told to show. */
function panelText(panel: StubPanel): string {
	return panel.shown.at(-1) ?? '';
}
function panelIsError(panel: StubPanel): boolean {
	return panel.reports.some((r) => r.severity === 'error');
}

let getServerStatus: (options: unknown) => void;

/**
 * The envelope accessors the poller reads. They arrive by `import` in the
 * browser (core/common/js/api_error.js, render_api_error.js), and the harness
 * strips the import block — so they are installed as globals, exactly the way
 * `data_manager` / `ui` already are.
 *
 * `request_failed` / `response_data` / `normalize_api_error` are the REAL,
 * dependency-free client source. `error_text` cannot be imported (its module
 * pulls ui.js → tool_common.js, which does not resolve off the HTTP root), so
 * it is the documented equivalent of render_api_error.js's chain WITH AN EMPTY
 * LABEL CATALOGUE — which is precisely the state of this harness: no labels
 * loaded ⇒ `message`, else the code.
 */
interface ClientEnvelopeHelpers {
	request_failed: (response: unknown) => boolean;
	response_data: (response: unknown) => unknown;
	normalize_api_error: (response: unknown, body: unknown) => unknown;
}
let clientHelpers: ClientEnvelopeHelpers;

async function installClientEnvelopeHelpers(): Promise<void> {
	clientHelpers = (await import(
		'../../client/dedalo/core/common/js/api_error.js'
	)) as unknown as ClientEnvelopeHelpers;
	// biome-ignore lint/suspicious/noExplicitAny: browser globals the client module reads free.
	const g = globalThis as any;
	g.request_failed = clientHelpers.request_failed;
	g.response_data = clientHelpers.response_data;
	g.error_text = (error: { message?: string; code?: string } | null) =>
		typeof error?.message === 'string' && error.message.length > 0
			? error.message
			: String(error?.code ?? '');
}

/**
 * A failure envelope as the POLLER receives it: data_manager parses the wire
 * body and replaces `error` with the normalized ApiError before resolving
 * (data_manager.request step 9), so the client-side gate must be fed that, not
 * the raw JSON.
 */
function clientFailure(body: WireFailure): Record<string, unknown> {
	return { ...body, error: clientHelpers.normalize_api_error(null, body) };
}

/** The same, minted from a code + message (no live harvest needed). */
function refusedEnvelope(code: string, message: string): Record<string, unknown> {
	return clientFailure({
		ok: false,
		request_id: 'client-poll-test',
		error: {
			code,
			message,
			label_key: `error_${code.replace(/\W/g, '_')}`,
			category: 'unavailable',
		},
	});
}

async function loadClientPoller(): Promise<(options: unknown) => void> {
	const raw = await Bun.file(CLIENT_SOURCE).text();
	// named ({ a, b }) OR default (Split) imports — the module uses both.
	const stripped = raw.replace(
		/^[ \t]*import\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+'[^']*'[ \t]*;?[ \t]*$/gm,
		'',
	);
	// Fail LOUDLY if the import shape changed: a silent strip failure would make
	// the whole describe unloadable-but-green in the worst case.
	// (!) Asserts NO import survives, rather than naming one path prefix: the
	// previous check only knew about '../../../core/', so a default import of
	// '../../../lib/split/…' sailed past it and blew up at module load instead.
	if (/^[ \t]*import\s/m.test(stripped)) {
		throw new Error('client harness: the import block was not stripped — update the regex');
	}
	if (!stripped.includes('const get_server_status')) {
		throw new Error('client harness: get_server_status not found in the client source');
	}
	const probe = `${ROOT}/client_probe/render_tool_transcription.probe.mjs`;
	await Bun.write(probe, `${stripped}\nexport { get_server_status }\n`);
	const module = (await import(probe)) as { get_server_status: (options: unknown) => void };
	return module.get_server_status;
}

/** Drive one poll cycle against a stubbed browser world. */
async function drivePoll(response: unknown, storedPid: number | null = 4321) {
	const deleted: string[] = [];
	const scheduled: number[] = [];
	const refreshes: number[] = [];
	const requests: unknown[] = [];
	const status_panel = stubPanel();
	const button = stubNode('disable');

	// biome-ignore lint/suspicious/noExplicitAny: browser globals the client module reads free.
	const g = globalThis as any;
	const prior = { data_manager: g.data_manager, setTimeout: g.setTimeout, ui: g.ui };
	// `ui` is one of the module-scope imports the harness strips, so the poller
	// reads it free like data_manager. Recording the busy toggles here is what
	// keeps the trigger's spinner honest: every path that gives the button back
	// must also stop it spinning, or a settled job leaves a live spinner over a
	// panel that says the work is done.
	const busy: boolean[] = [];
	g.ui = {
		set_button_busy: (_node: unknown, is_busy: boolean) => {
			busy.push(is_busy);
		},
	};
	g.data_manager = {
		get_local_db_data: async (id: string) => (storedPid === null ? null : { id, pid: storedPid }),
		delete_local_db_data: (id: string) => {
			deleted.push(id);
		},
	};
	// Record the re-poll / refresh scheduling WITHOUT firing it (4s in real time).
	g.setTimeout = (_fn: unknown, ms: number) => {
		scheduled.push(ms);
		return 0;
	};
	const self = {
		media_component: { section_tipo: 'test3', section_id: 1 },
		transcription_component: {
			refresh: () => {
				refreshes.push(1);
			},
		},
		get_tool_label: () => null, // unlabelled instance → the literal fallbacks
		check_server_transcriber_status: async (options: unknown) => {
			requests.push(options);
			return response;
		},
	};
	const nodes = {
		status_panel,
		button_automatic_transcription: button,
		transcriber_engine_select: { value: 'babel_transcriber' },
	};

	try {
		getServerStatus({ self, nodes });
		// every stubbed await resolves immediately: draining the microtask queue
		// runs the whole poll deterministically, with no wall-clock dependency.
		for (let i = 0; i < 100; i++) await Promise.resolve();
	} finally {
		g.data_manager = prior.data_manager;
		g.setTimeout = prior.setTimeout;
		g.ui = prior.ui;
	}

	return { deleted, scheduled, refreshes, requests, status_panel, button, busy };
}

describe('client poll honesty (render_tool_transcription.get_server_status)', () => {
	beforeAll(async () => {
		await installClientEnvelopeHelpers();
		getServerStatus = await loadClientPoller();
	});

	test('an ok:false envelope is NOT rendered as a finished transcription', async () => {
		const run = await drivePoll(
			refusedEnvelope('tool.dependency_unavailable', 'invalid transcriber URL'),
		);
		// the whole point: the user must not read "Process done"
		expect(panelText(run.status_panel)).not.toBe('Process done');
		expect(panelText(run.status_panel)).toContain('invalid transcriber URL');
		expect(panelIsError(run.status_panel)).toBe(true);
		// a failure is a REPORT, never the transient progress line: progress is
		// overwritten by the next percentage, a report stands.
		expect(run.status_panel.reports.length).toBe(1);
		// the pid is the only handle on the running job — it must survive
		expect(run.deleted).toEqual([]);
		// polling STOPS: no re-poll, and no component refresh was scheduled
		expect(run.scheduled).toEqual([]);
		expect(run.refreshes).toEqual([]);
	});

	test('a status-less / malformed envelope is treated as a failure, not as done', async () => {
		for (const response of [
			undefined,
			null,
			{},
			{ ok: true, data: null },
			{ ok: true, data: 'unexpected' },
		]) {
			const run = await drivePoll(response);
			expect(panelText(run.status_panel)).not.toBe('Process done');
			expect(panelIsError(run.status_panel)).toBe(true);
			expect(run.deleted).toEqual([]);
			expect(run.scheduled).toEqual([]);
		}
	});

	test('the failure branch does not re-enable the button (a job may still be running)', async () => {
		const run = await drivePoll(
			refusedEnvelope('tool.dependency_unavailable', 'transcriber HTTP 502'),
		);
		expect(run.button.classList.contains('disable')).toBe(true);
	});

	test('status 2 still re-polls and keeps the pid, and the trigger spins', async () => {
		const run = await drivePoll({ ok: true, data: { status: 2 } });
		expect(panelText(run.status_panel)).toBe('Processing');
		expect(panelIsError(run.status_panel)).toBe(false);
		expect(run.deleted).toEqual([]);
		expect(run.scheduled).toEqual([4000]);
		// A job found already running (a reload, or another window) must LOOK
		// running, even though this page never pressed the button.
		expect(run.busy).toEqual([true]);
	});

	test('status 3 still clears the pid and refreshes the component, and stops the spinner', async () => {
		const run = await drivePoll({ ok: true, data: { status: 3 } });
		expect(panelText(run.status_panel)).toBe('Process done');
		// A finished run reports as `success`, never as `info`: the panel paints
		// severity, and an outcome sharing the neutral grey of "the model is
		// unverified" is an end the archivist has to infer.
		expect(run.status_panel.reports.at(-1)?.severity).toBe('success');
		expect(run.deleted).toEqual(['transcriber_process_test3_1']);
		expect(run.scheduled).toEqual([4000]);
		expect(run.busy).toEqual([false]);
	});

	test('status 1 still clears the stale pid, reads Inactive and stops the spinner', async () => {
		const run = await drivePoll({ ok: true, data: { status: 1 } });
		expect(panelText(run.status_panel)).toBe('Inactive');
		expect(run.deleted).toEqual(['transcriber_process_test3_1']);
		expect(run.scheduled).toEqual([]);
		expect(run.busy).toEqual([false]);
	});

	/**
	 * The two halves, joined: the envelope the SERVER really emits for a dead
	 * transcriber, fed to the REAL browser poller. This is the gate that would
	 * catch either half drifting — a server that starts dressing failures as OK,
	 * or a client that starts trusting a status-less result again.
	 */
	test('the real server failure envelope renders as a failure in the browser', async () => {
		const envelope = liveFailureEnvelope();
		expect(envelope.ok).toBe(false); // the harvest actually ran
		const run = await drivePoll(clientFailure(envelope));
		expect(panelText(run.status_panel)).toContain(envelope.error.message);
		expect(panelIsError(run.status_panel)).toBe(true);
		expect(run.deleted).toEqual([]);
		expect(run.scheduled).toEqual([]);
	});

	test('no stored pid → the poll never calls the server at all', async () => {
		const run = await drivePoll({ ok: true, data: { status: 3 } }, null);
		expect(run.requests).toEqual([]);
		expect(run.status_panel.shown).toEqual([]);
	});
});

describe('saveTranscriptionResult — the id-1 slot contract', () => {
	// THE transcription is the lang's single main text: item id 1, stated
	// explicitly. The id-less update this used to send relied on slice/sibling
	// resolution and APPENDED with a minted id when nothing resolved — a
	// finished 87-minute transcription landed invisible in item 2 while the
	// editor showed the empty item 1 (an install's rsc167/528, 2026-07-28).
	test('an empty component receives the transcript as item id 1', async () => {
		const { saveTranscriptionResult } = await import('../../src/core/tools/transcription_asr.ts');
		const { insertMatrixRecordWithCounter, deleteMatrixRecord } = await import(
			'../../src/core/db/matrix_write.ts'
		);
		const { readMatrixRecord } = await import('../../src/core/db/matrix.ts');
		const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');

		const table = (await getMatrixTableFromTipo('test3'))!;
		const sectionId = await insertMatrixRecordWithCounter(table, 'test3', {});
		try {
			const outcome = await saveTranscriptionResult({
				lang: 'lg-eng',
				transcriptionDdo: {
					component_tipo: 'test17',
					section_tipo: 'test3',
					section_id: sectionId,
				},
				segments: [{ start: 0, end: 4, text: ' Hello world.' }],
				userId: -1,
			});
			expect(outcome.saved).toBe(true);

			const record = await readMatrixRecord(table, 'test3', sectionId);
			const items = (record?.columns.string as Record<string, unknown[]>)?.test17 as {
				id?: unknown;
				lang?: string;
				value?: string;
			}[];
			expect(items).toHaveLength(1);
			expect(Number(items[0]?.id)).toBe(1); // the slot is STATED, never minted
			expect(items[0]?.lang).toBe('lg-eng');
			expect(items[0]?.value).toContain('Hello world.');
		} finally {
			await deleteMatrixRecord(table, 'test3', sectionId);
		}
	});
});

describe('remote ASR status seam', () => {
	const statusRequest: TranscriberStatusRequest = {
		uri: 'https://babel.example.org:8011/api/',
		key: 'k',
		avUrl: 'https://dedalo.example.org/dedalo/media/av/404/test94_test3_1.mp3',
		engine: 'babel_transcriber',
		userId: 7,
		entityName: 'myentity',
		pid: 4321,
		deleteResult: false,
	};

	test('buildTranscriberStatusBody POSTs the exact PHP field set', () => {
		const body = buildTranscriberStatusBody(statusRequest);
		expect([...body.keys()].sort()).toEqual([
			'av_url',
			'delete_result',
			'engine',
			'entity_name',
			'key',
			'method_name',
			'pid',
			'url',
			'user_id',
		]);
		expect(body.get('key')).toBe('k');
		expect(body.get('url')).toBe('https://babel.example.org:8011/api/'); // PHP posts the uri as 'url'
		expect(body.get('av_url')).toBe(statusRequest.avUrl);
		expect(body.get('engine')).toBe('babel_transcriber');
		expect(body.get('method_name')).toBe('check_status');
		expect(body.get('user_id')).toBe('7');
		expect(body.get('entity_name')).toBe('myentity');
		expect(body.get('pid')).toBe('4321');
		expect(body.get('delete_result')).toBe('false');
	});

	test('the background variant carries lang + delete_result true', () => {
		const body = buildTranscriberStatusBody({
			...statusRequest,
			deleteResult: true,
			lang: 'lg-spa',
		});
		expect(body.get('delete_result')).toBe('true');
		expect(body.get('lang')).toBe('lg-spa');
	});

	test('SSRF guard fails closed without any network call', async () => {
		for (const uri of ['http://127.0.0.1/x', 'http://169.254.169.254/x', 'file:///etc/passwd']) {
			const result = (await babelTranscriberStatusProvider({ ...statusRequest, uri })) as {
				ok: unknown;
				msg: string;
			};
			expect(result.ok).toBe(false);
			expect(result.msg).toBe('invalid transcriber URL');
		}
	});

	test('status provider resolution mirrors the PHP switch', () => {
		expect(resolveTranscriberStatusProvider('babel_transcriber').provider).not.toBeNull();
		expect(resolveTranscriberStatusProvider('local').provider).not.toBeNull();
		expect(resolveTranscriberStatusProvider('google_translation').provider).toBeNull();
		expect(resolveTranscriberStatusProvider('google_translation').error).toContain(
			'not implemented',
		);
	});

	test("engine 'local' maps to babel (PHP fall-through) for submit too", () => {
		expect(mapTranscriberEngine('local')).toBe('babel_transcriber');
		expect(mapTranscriberEngine('babel_transcriber')).toBe('babel_transcriber');
		expect(resolveTranscriberProvider('local').provider).not.toBeNull();
	});
});

describe('ASR write-back (process_file port)', () => {
	test('seg2tc parity (OptimizeTC::seg2tc)', () => {
		expect(secondsToTc(0)).toBe('00:00:00.000');
		expect(secondsToTc(1.85)).toBe('00:00:01.850');
		expect(secondsToTc(3.45)).toBe('00:00:03.450');
		expect(secondsToTc(322.342)).toBe('00:05:22.342');
		expect(secondsToTc(3661.007)).toBe('01:01:01.007');
		expect(secondsToTc(7322.5)).toBe('02:02:02.500');
		expect(secondsToTc(59)).toBe('00:00:59.000');
	});

	test('segmentsToTcText groups segments into paragraphs', () => {
		// Two consecutive segments of one answer: ONE paragraph, one time mark.
		// (It used to be one paragraph per segment — a cue list, not a transcript.)
		const segments = [
			{ start: 1.85, end: 3.45, text: ' Can you say me...' },
			{ start: 3.45, end: 6, text: ' blah blah...' },
		];
		expect(segmentsToTcText(segments)).toBe(
			'<p>[TC_00:00:01.850_TC]Can you say me... blah blah...</p>',
		);
		expect(segmentsToTcText([])).toBe('');
	});

	test('segmentsToTcText breaks a paragraph at a silence', () => {
		const segments = [
			{ start: 0, end: 4, text: 'Primera respuesta' },
			{ start: 20, end: 24, text: 'Segunda respuesta' },
		];
		expect(segmentsToTcText(segments)).toBe(
			'<p>[TC_00:00:00.000_TC]Primera respuesta</p><p>[TC_00:00:20.000_TC]Segunda respuesta</p>',
		);
	});

	test('segmentsToTcText honours the caller’s timecode density', () => {
		const segments = [
			{ start: 0, end: 4, text: 'uno' },
			{ start: 4, end: 8, text: 'dos' },
		];
		// 'segment' reproduces the historical one-mark-per-segment output.
		expect(segmentsToTcText(segments, { tc_mode: 'segment' })).toBe(
			'<p>[TC_00:00:00.000_TC]uno</p><p>[TC_00:00:04.000_TC]dos</p>',
		);
	});

	test('hasExistingTranscription: any item in the target lang blocks the save', () => {
		expect(hasExistingTranscription([], 'lg-spa')).toBe(false);
		expect(hasExistingTranscription([{ value: 'x', lang: 'lg-eng' }], 'lg-spa')).toBe(false);
		// PHP: an object item is non-empty even with an empty value → skip.
		expect(hasExistingTranscription([{ value: '', lang: 'lg-spa' }], 'lg-spa')).toBe(true);
		expect(hasExistingTranscription([{ value: 'manual edit', lang: 'lg-spa' }], 'lg-spa')).toBe(
			true,
		);
	});

	const pollJob = {
		status: {
			uri: 'https://babel.example.org/api/',
			key: 'k',
			avUrl: 'https://x/a.mp3',
			engine: 'babel_transcriber',
			userId: 7,
			entityName: 'myentity',
			pid: 99,
			lang: 'lg-spa',
		},
		lang: 'lg-spa',
		transcriptionDdo: { component_tipo: 'test17', section_tipo: 'test3', section_id: 1 },
		userId: 7,
	};

	test('poll: waits on status 2, saves segments on status 3 (delete_result=true)', async () => {
		const seen: TranscriberStatusRequest[] = [];
		const sequence: unknown[] = [
			{ status: 2 },
			{ status: 2 },
			{ status: 3, transcription_data: { segments: [{ start: 1.85, text: ' hi' }] } },
		];
		let sleeps = 0;
		const saves: unknown[] = [];
		const outcome = await pollTranscriptionCompletion(pollJob, {
			provider: async (req) => {
				seen.push(req);
				return sequence.shift();
			},
			save: async (input) => {
				saves.push(input);
				return { saved: true, msg: 'OK. Transcription saved' };
			},
			maxAttempts: 10,
			intervalMs: 1,
			sleep: async () => {
				sleeps += 1;
			},
		});
		expect(outcome.ok).toBe(true);
		expect(sleeps).toBe(2);
		expect(seen).toHaveLength(3);
		// server-side polls are the destructive ones (PHP delete_result=true)
		expect(seen.every((req) => req.deleteResult === true)).toBe(true);
		expect(saves).toHaveLength(1);
		expect(saves[0]).toMatchObject({
			lang: 'lg-spa',
			transcriptionDdo: pollJob.transcriptionDdo,
			segments: [{ start: 1.85, text: ' hi' }],
			userId: 7,
		});
	});

	test('poll: the save guard outcome propagates (skip is not a crash)', async () => {
		const outcome = await pollTranscriptionCompletion(pollJob, {
			provider: async () => ({
				status: 3,
				transcription_data: { segments: [{ start: 0, text: 'x' }] },
			}),
			save: async () => ({ saved: false, msg: 'component already has data — skipped' }),
			maxAttempts: 2,
			sleep: async () => {},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.msg).toContain('already has data');
	});

	test('poll: bounded — gives up loudly after maxAttempts, never throws', async () => {
		const outcome = await pollTranscriptionCompletion(pollJob, {
			provider: async () => ({ status: 2 }),
			save: async () => ({ saved: true, msg: 'unreachable' }),
			maxAttempts: 3,
			sleep: async () => {},
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.msg).toContain('gave up after 3 poll attempts');
	});

	test('poll: status 1 and invalid statuses terminate without saving', async () => {
		const status1 = await pollTranscriptionCompletion(pollJob, {
			provider: async () => ({ status: 1 }),
			save: async () => {
				throw new Error('must not save');
			},
			maxAttempts: 2,
			sleep: async () => {},
		});
		expect(status1.ok).toBe(false);
		expect(status1.msg).toContain('status 1');

		const invalid = await pollTranscriptionCompletion(pollJob, {
			provider: async () => ({ ok: false, msg: 'invalid transcriber URL' }),
			save: async () => {
				throw new Error('must not save');
			},
			maxAttempts: 2,
			sleep: async () => {},
		});
		expect(invalid.ok).toBe(false);
		expect(invalid.msg).toContain('status not valid');
	});
});

describe('remote ASR seam', () => {
	test('resolveTranscriberProvider: babel default, others rejected', () => {
		expect(resolveTranscriberProvider('babel_transcriber').provider).not.toBeNull();
		expect(resolveTranscriberProvider('whisper_x').provider).toBeNull();
		expect(resolveTranscriberProvider('whisper_x').error).toContain('not implemented');
	});
	test('resolveTranscriberConfig reads the shape getToolConfig ACTUALLY returns', () => {
		// getToolConfig returns the EFFECTIVE config: a flat map of key → resolved
		// value. The lookup used to read `config.transcriber_config.value`, a shape
		// it never produces, so no server-side engine could ever find its uri/key —
		// and the old fixture here was written to that same wrong shape, so the gate
		// stayed green while the feature was dead. This asserts the real one first.
		const effective = {
			transcriber_config: [{ name: 'babel_transcriber', uri: 'u', key: 'k' }],
		};
		expect(resolveTranscriberConfig(effective, 'babel_transcriber')).toEqual({
			uri: 'u',
			key: 'k',
		});

		// The raw-property forms an install may store are still accepted.
		expect(
			resolveTranscriberConfig(
				{ transcriber_config: { value: [{ name: 'local_whisper', uri: 'u2', key: 'k2' }] } },
				'local_whisper',
			),
		).toEqual({ uri: 'u2', key: 'k2' });
		expect(
			resolveTranscriberConfig(
				{
					config: {
						transcriber_config: { value: [{ name: 'babel_transcriber', uri: 'u', key: 'k' }] },
					},
				},
				'babel_transcriber',
			),
		).toEqual({ uri: 'u', key: 'k' });

		expect(resolveTranscriberConfig({}, 'babel_transcriber')).toBeNull();
		// An entry missing either half is not usable config.
		expect(
			resolveTranscriberConfig(
				{ transcriber_config: [{ name: 'babel_transcriber', uri: 'u' }] },
				'babel_transcriber',
			),
		).toBeNull();
	});
});

describe('model actions are admin-gated and catalog-bound', () => {
	const nonAdmin = { isGlobalAdmin: false } as unknown as ToolActionContext['principal'];

	test('repair_model refuses a non-admin', async () => {
		const refusal = await refusalOf(
			tool.apiActions.repair_model!.handler({
				options: { model: 'onnx-community/whisper-large-v3-turbo-ONNX' },
				principal: nonAdmin,
				userId: 1,
			} as unknown as ToolActionContext),
		);
		expect(refusal.code).toBe('perm.denied');
	});

	test('repair_model refuses a model outside the catalog', async () => {
		const refusal = await refusalOf(
			tool.apiActions.repair_model!.handler({
				options: { model: 'evil/not-in-catalog' },
				principal: { isGlobalAdmin: true },
				userId: 1,
			} as unknown as ToolActionContext),
		);
		expect(refusal.code).toBe('tool.unsupported_target');
		expect(String(refusal.publicMessage)).toContain('not in the transcriber catalog');
	});

	test('verify_model refuses a non-admin', async () => {
		const refusal = await refusalOf(
			tool.apiActions.verify_model!.handler({
				options: { model: 'onnx-community/whisper-large-v3-turbo-ONNX' },
				principal: nonAdmin,
				userId: 1,
			} as unknown as ToolActionContext),
		);
		expect(refusal.code).toBe('perm.denied');
	});

	// A REAL name from the register default catalog (tools/tool_transcription/
	// register.json dd1633.transcriber_quality) — present in the test DB the same
	// way it is in any install, no scratch DB row needed. It exists precisely to
	// prove the catalog gate ACCEPTS a valid name and not merely that it refuses
	// invalid ones: the four refusal-only tests above would stay green even
	// behind a stub that unconditionally returns `fail(...)`, and the "outside
	// the catalog" test above passes `isGlobalAdmin: true` and so does NOT return
	// from the admin gate — it reaches `catalogEntry()` (a real DB read) and is
	// refused for the catalog reason. Neither proves the ACCEPT path.
	const KNOWN_CATALOG_MODEL = 'onnx-community/whisper-large-v3-turbo';
	const admin = { isGlobalAdmin: true } as unknown as ToolActionContext['principal'];

	test('verify_model accepts a known catalog model and refuses a neighbor — no network', async () => {
		// Empty scratch store: every file evidences `present: false`, so
		// verifyModelAction's HEAD loop (`!file.present` guard) never fires a
		// request — the catalog-acceptance proof stays honestly network-free.
		const scratchStore = `${ROOT}/verify_store_scratch`;
		mkdirSync(scratchStore, { recursive: true });
		const prior = process.env.DEDALO_AI_MODEL_STORE;
		process.env.DEDALO_AI_MODEL_STORE = scratchStore;
		try {
			const accepted = await tool.apiActions.verify_model!.handler({
				options: { model: KNOWN_CATALOG_MODEL },
				principal: admin,
				userId: 1,
			} as unknown as ToolActionContext);
			// Distinct from the catalog refusal: the gate let it through, and the
			// verdict is DATA now (`state`), not a sentence inside a msg string.
			expect(accepted.ok).toBe(true);
			expect((accepted.data as { state?: string }).state).toBeString();

			const refusal = await refusalOf(
				tool.apiActions.verify_model!.handler({
					options: { model: 'evil/not-in-catalog' },
					principal: admin,
					userId: 1,
				} as unknown as ToolActionContext),
			);
			expect(refusal.code).toBe('tool.unsupported_target');
			expect(String(refusal.publicMessage)).toContain('not in the transcriber catalog');
		} finally {
			if (prior === undefined) delete process.env.DEDALO_AI_MODEL_STORE;
			else process.env.DEDALO_AI_MODEL_STORE = prior;
		}
	});

	test('verify_model judges a PINNED catalog model LOCALLY: wrong bytes → damaged + quarantined (no network)', async () => {
		// P1-25: the catalog model has a repo pin (src/core/ai/model_pins.json), so
		// verification is a sha256 against it — no hub HEAD, nothing leaves the box.
		// Both files are pinned (config + the dtype's fp16 encoder) and both carry
		// bytes that are NOT the pinned ones — a plausible header is not a verdict.
		const scratchStore = `${ROOT}/verify_store_pinned`;
		const modelDir = `${scratchStore}/${KNOWN_CATALOG_MODEL}`;
		mkdirSync(`${modelDir}/onnx`, { recursive: true });
		writeFileSync(`${modelDir}/config.json`, '{"model_type":"whisper","tampered":true}');
		writeFileSync(`${modelDir}/onnx/encoder_model_fp16.onnx`, '\x08NOT-THE-PINNED-BYTES');
		const prior = process.env.DEDALO_AI_MODEL_STORE;
		process.env.DEDALO_AI_MODEL_STORE = scratchStore;
		try {
			const verdict = await tool.apiActions.verify_model!.handler({
				options: { model: KNOWN_CATALOG_MODEL },
				principal: admin,
				userId: 1,
			} as unknown as ToolActionContext);
			expect(verdict.ok).toBe(true);
			const data = verdict.data as { state: string; quarantined: string[]; unverifiable: string[] };
			expect(data.state).toBe('damaged');
			expect([...data.quarantined].sort()).toEqual(['config.json', 'onnx/encoder_model_fp16.onnx']);
			expect(data.unverifiable).toEqual([]);
			expect(existsSync(`${modelDir}/config.json`)).toBe(false);
			expect(existsSync(`${modelDir}/onnx/encoder_model_fp16.onnx`)).toBe(false);
			expect(existsSync(`${scratchStore}/.quarantine/${KNOWN_CATALOG_MODEL}`)).toBe(true);
		} finally {
			if (prior === undefined) delete process.env.DEDALO_AI_MODEL_STORE;
			else process.env.DEDALO_AI_MODEL_STORE = prior;
		}
	});

	test('repair_model reaches the scheduling seam for a known catalog model, refuses a neighbor', async () => {
		// scheduleBackground fires a fully detached job (real network fetch, real
		// store writes) that nothing inside repairModelAction can stop once
		// called — so the ACCEPT path is proven through the injectable
		// `ScheduleRepair` seam instead of the real one (see its doc comment in
		// tools/tool_transcription/server/index.ts).
		const calls: Parameters<ScheduleRepair>[] = [];
		const stubSchedule: ScheduleRepair = (...args) => {
			calls.push(args);
			return ok(true, { requestId: 'tool-transcription-test' });
		};

		const accepted = await repairModelAction(
			{
				options: { model: KNOWN_CATALOG_MODEL },
				principal: admin,
				userId: 1,
			} as unknown as ToolActionContext,
			stubSchedule,
		);
		expect(accepted.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBe('background_repair_model');
		expect((calls[0]?.[3] as { model?: string } | undefined)?.model).toBe(KNOWN_CATALOG_MODEL);

		const refusal = await refusalOf(
			repairModelAction(
				{
					options: { model: 'evil/not-in-catalog' },
					principal: admin,
					userId: 1,
				} as unknown as ToolActionContext,
				stubSchedule,
			),
		);
		expect(refusal.code).toBe('tool.unsupported_target');
		expect(String(refusal.publicMessage)).toContain('not in the transcriber catalog');
		// The refusal never reached scheduling: still just the one call above.
		expect(calls).toHaveLength(1);
		// The stub never runs the job, so the in-flight guard this accept path set
		// would otherwise stay set and refuse every later repair of this model.
		releaseModelRepairLock(KNOWN_CATALOG_MODEL);
	});

	// Deviation from the brief text: only repair_model is backgrounded (verify
	// runs inline — see the design decision above), so there is no
	// 'background_verify_model' action to assert about. This checks the
	// background action that actually exists: allowlisted, never client-routable.
	test('the repair background action is allowlisted but not client-routable', () => {
		expect(Object.keys(tool.apiActions)).not.toContain('background_repair_model');
		expect(tool.backgroundRunnable).toContain('background_repair_model');
	});
});

/**
 * THE ONLY CODE IN THIS SUBSYSTEM THAT DELETES FILES.
 *
 * `backgroundRepairModel` is where every remedy button in both clients ends up,
 * and the whole change exists to stop a wrong "success". Three ways it used to be
 * wrong, each gated below:
 *
 *  - it treated EVERY file as suspect as soon as the model's overall state was
 *    `damaged`, so one HTML error page took the healthy weights with it;
 *  - it then re-fetched `modelFiles(dtype)` rather than what it removed, so a
 *    dtype-less repair replaced a working q4 install with the fp32 set;
 *  - it never looked at the common files at all, so a corrupt tokenizer survived
 *    a repair that reported success.
 *
 * Driven through the injectable downloader seam over a SCRATCH store: never the
 * network, never the real store.
 */
describe('backgroundRepairModel — deletes only what fails, restores only what it deleted', () => {
	const REPAIR_STORE = `${ROOT}/repair_store`;
	const MODEL = 'scratch/repair-model';
	const DTYPE = { encoder_model: 'q4', decoder_model_merged: 'q4' };

	/** A plausible ONNX payload: first byte 0x08 (protobuf field 1, ir_version). */
	const ONNX = Buffer.from([0x08, 0x07, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74]);

	function seed(files: Record<string, Buffer | string>): void {
		rmSync(`${REPAIR_STORE}/${MODEL}`, { recursive: true, force: true });
		mkdirSync(`${REPAIR_STORE}/${MODEL}/onnx`, { recursive: true });
		for (const [file, body] of Object.entries(files)) {
			const path = `${REPAIR_STORE}/${MODEL}/${file}`;
			mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
			writeFileSync(path, body);
		}
	}

	/** The healthy ASR set: config + q4 weights + every common file. */
	function healthyFiles(): Record<string, Buffer | string> {
		return {
			'config.json': '{"model_type":"whisper"}',
			'onnx/encoder_model_q4.onnx': ONNX,
			'onnx/decoder_model_merged_q4.onnx': ONNX,
			'tokenizer.json': '{"version":"1"}',
			'tokenizer_config.json': '{}',
			'generation_config.json': '{}',
			'preprocessor_config.json': '{}',
		};
	}

	/**
	 * A downloader that records what it was asked for and re-creates it. `ok`
	 * false makes the re-download fail without touching the network.
	 */
	function recordingDownload(options: { ok: boolean } = { ok: true }) {
		const asked: string[][] = [];
		const download = (async (
			_model: string,
			_dtype: Record<string, string> | undefined,
			opts: { files?: readonly string[] } = {},
		) => {
			const files = [...(opts.files ?? [])];
			asked.push(files);
			if (!options.ok) {
				return { ok: false, files: [], skipped: [], errors: ['download failed from the hub'] };
			}
			for (const file of files) {
				const path = `${REPAIR_STORE}/${MODEL}/${file}`;
				mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
				writeFileSync(path, file.endsWith('.onnx') ? ONNX : '{"restored":true}');
			}
			return { ok: true, files, skipped: [], errors: [] };
		}) as unknown as typeof import('../../src/core/ai/model_fetch.ts').downloadModel;
		return { asked, download };
	}

	function ctx(options: Record<string, unknown>): ToolActionContext {
		return {
			options,
			principal: { isGlobalAdmin: true },
			userId: 1,
		} as unknown as ToolActionContext;
	}

	let priorStore: string | undefined;
	beforeAll(() => {
		priorStore = process.env.DEDALO_AI_MODEL_STORE;
		mkdirSync(REPAIR_STORE, { recursive: true });
		process.env.DEDALO_AI_MODEL_STORE = REPAIR_STORE;
	});
	afterAll(() => {
		if (priorStore === undefined) delete process.env.DEDALO_AI_MODEL_STORE;
		else process.env.DEDALO_AI_MODEL_STORE = priorStore;
	});

	test('one corrupt weight file: only that file is deleted, and exactly it is re-fetched', async () => {
		const files = healthyFiles();
		// An HTML error page written over ONE weight file — the `damaged` case.
		files['onnx/encoder_model_q4.onnx'] = '<!doctype html><h1>502</h1>';
		seed(files);
		const decoderBefore = Bun.file(
			`${REPAIR_STORE}/${MODEL}/onnx/decoder_model_merged_q4.onnx`,
		).size;

		const { asked, download } = recordingDownload();
		const response = await backgroundRepairModel(ctx({ model: MODEL, dtype: DTYPE, kind: 'asr' }), {
			download,
		});

		expect(response.ok).toBe(true);
		// EXACTLY the failing file: not the decoder, not the config, not a common file.
		expect(asked).toEqual([['onnx/encoder_model_q4.onnx']]);
		// The healthy weight was never touched.
		expect(Bun.file(`${REPAIR_STORE}/${MODEL}/onnx/decoder_model_merged_q4.onnx`).size).toBe(
			decoderBefore,
		);
		// And the quantisation that came back is the one that went away.
		expect(existsSync(`${REPAIR_STORE}/${MODEL}/onnx/encoder_model_q4.onnx`)).toBe(true);
		expect(existsSync(`${REPAIR_STORE}/${MODEL}/onnx/encoder_model.onnx`)).toBe(false);
	});

	test('a corrupt COMMON file is repaired too, and the success names what was checked', async () => {
		// modelState never evidences tokenizer.json, so a corrupt one used to
		// survive a repair that then reported success — the one forbidden outcome.
		const files = healthyFiles();
		files['tokenizer.json'] = '<html>proxy error</html>';
		seed(files);

		const { asked, download } = recordingDownload();
		const response = await backgroundRepairModel(ctx({ model: MODEL, dtype: DTYPE, kind: 'asr' }), {
			download,
		});

		expect(response.ok).toBe(true);
		expect(asked).toEqual([['tokenizer.json']]);
		// The repaired count is DATA now; the "weights, config and N common file(s)"
		// sentence stays in the server log, where the operator reads it.
		expect((response.data as { repaired?: number }).repaired).toBe(1);
	});

	test('a healthy model reports nothing to repair and deletes nothing', async () => {
		seed(healthyFiles());
		const { asked, download } = recordingDownload();
		const response = await backgroundRepairModel(ctx({ model: MODEL, dtype: DTYPE, kind: 'asr' }), {
			download,
		});
		expect(response.ok).toBe(true);
		expect((response.data as { repaired?: number }).repaired).toBe(0);
		expect(asked).toEqual([]);
		expect(existsSync(`${REPAIR_STORE}/${MODEL}/onnx/encoder_model_q4.onnx`)).toBe(true);
	});

	test('unknown quantisation: it REFUSES rather than deleting what it cannot fetch back', async () => {
		// The live dtype-less case: the catalog declares no dtype and the store
		// holds no complete weight pair, so the only file names available are the
		// fp32 PLACEHOLDERS modelFiles() invents. Deleting a weight on that
		// authority is how a working q4 install became a ~3 GB fp32 download.
		seed({
			'config.json': '{"model_type":"whisper"}',
			'onnx/encoder_model_q4.onnx': ONNX,
		});

		const { asked, download } = recordingDownload();
		const refusal = await refusalOf(
			backgroundRepairModel(ctx({ model: MODEL, kind: 'asr' }), { download }),
		);

		expect(refusal.code).toBe('tool.unsupported_target');
		expect(String(refusal.publicMessage)).toContain('Repair refused');
		expect(String(refusal.publicMessage)).toContain('cannot be named to fetch back');
		// Nothing was deleted and nothing was downloaded.
		expect(asked).toEqual([]);
		expect(existsSync(`${REPAIR_STORE}/${MODEL}/onnx/encoder_model_q4.onnx`)).toBe(true);
	});

	test('a failed re-download reports result:false — never a success over a missing file', async () => {
		const files = healthyFiles();
		files['onnx/encoder_model_q4.onnx'] = '<!doctype html>';
		seed(files);

		const { download } = recordingDownload({ ok: false });
		// A BACKGROUND job's failure is a THROW: the executor records it on the job
		// (status 'error' + `error`), which is what get_background_job_status serves.
		const refusal = await refusalOf(
			backgroundRepairModel(ctx({ model: MODEL, dtype: DTYPE, kind: 'asr' }), { download }),
		);
		expect(refusal.code).toBe('tool.action_failed');
		expect(refusal.message).toContain('download failed');
	});

	test('a second concurrent repair is refused SERVER-side', async () => {
		// A disabled button is not a guard: the action is on the wire and two tabs
		// reach it independently, racing rmSync and download over the same paths.
		const calls: Parameters<ScheduleRepair>[] = [];
		const stubSchedule: ScheduleRepair = (...args) => {
			calls.push(args);
			return ok(true, { requestId: 'tool-transcription-test' });
		};
		const KNOWN = 'onnx-community/whisper-large-v3-turbo';
		const admin = { isGlobalAdmin: true } as unknown as ToolActionContext['principal'];
		const request = () =>
			repairModelAction(
				{ options: { model: KNOWN }, principal: admin, userId: 1 } as unknown as ToolActionContext,
				stubSchedule,
			);

		try {
			const first = await request();
			expect(first.ok).toBe(true);

			const second = await refusalOf(request());
			expect(second.code).toBe('resource.conflict');
			expect(second.message).toContain('already running');
			// The refusal never reached scheduling.
			expect(calls).toHaveLength(1);
		} finally {
			// The stub never runs the job, so nothing reaches the finally that
			// normally clears the guard.
			releaseModelRepairLock(KNOWN);
		}

		// Released: the model is repairable again.
		const third = await request();
		expect(third.data).toBe(true);
		releaseModelRepairLock(KNOWN);
	});
});

/**
 * WHAT get_model_sources PROMISES THE CLIENT about the models it cannot pick in
 * the quality dropdown, and what download_model does with a model that is on
 * disk but broken.
 */
describe('model sources report a real state, and a download cannot claim a broken model', () => {
	const SOURCES_STORE = `${ROOT}/sources_store`;
	const KNOWN_CATALOG_MODEL = 'onnx-community/whisper-large-v3-turbo';
	const admin = { isGlobalAdmin: true } as unknown as ToolActionContext['principal'];

	let priorStore: string | undefined;
	beforeAll(() => {
		priorStore = process.env.DEDALO_AI_MODEL_STORE;
		mkdirSync(SOURCES_STORE, { recursive: true });
		process.env.DEDALO_AI_MODEL_STORE = SOURCES_STORE;
	});
	afterAll(() => {
		if (priorStore === undefined) delete process.env.DEDALO_AI_MODEL_STORE;
		else process.env.DEDALO_AI_MODEL_STORE = priorStore;
	});

	test('the speaker pair answers per half, and `installed` follows those states', async () => {
		const response = await tool.apiActions.get_model_sources!.handler({
			options: {},
			principal: admin,
			userId: 1,
		} as unknown as ToolActionContext);
		const result = response.data as {
			diarization: {
				installed: boolean;
				state: string;
				models: { role: string; name: string; state: string }[];
			} | null;
		};
		if (result.diarization === null) return; // this install declares no speaker model

		// ONE ENTRY PER HALF, each with its own name and its own state — a single
		// boolean could not say WHICH half was broken, so the remedy could not be
		// aimed and repaired the selected ASR model instead.
		expect(result.diarization.models.length).toBeGreaterThan(0);
		for (const part of result.diarization.models) {
			expect(typeof part.name).toBe('string');
			expect(['ready', 'unverified', 'incomplete', 'damaged', 'missing']).toContain(part.state);
			expect(['segmentation', 'embedding']).toContain(part.role);
		}
		// The empty scratch store: nothing is on disk, so nothing is runnable.
		expect(result.diarization.installed).toBe(false);
		expect(result.diarization.state).toBe('missing');
		// `installed` is exactly "every half runnable" — the same rule the ASR
		// list and the widget's usable count apply.
		expect(result.diarization.installed).toBe(
			result.diarization.models.every(
				(part) => part.state === 'ready' || part.state === 'unverified',
			),
		);
	});

	test('download_model refuses a model that is present but damaged, instead of "already installed"', async () => {
		// `modelInstalled` (size > 0) answered 'OK. Model already installed' here,
		// so the client polled for thirty minutes for a model already on disk and
		// unusable. A damaged model needs a repair, and is told so.
		const dir = `${SOURCES_STORE}/${KNOWN_CATALOG_MODEL}/onnx`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${SOURCES_STORE}/${KNOWN_CATALOG_MODEL}/config.json`,
			'{"model_type":"whisper"}',
		);
		writeFileSync(`${dir}/encoder_model.onnx`, '<!doctype html><h1>502</h1>');
		writeFileSync(`${dir}/decoder_model_merged.onnx`, '<!doctype html><h1>502</h1>');
		try {
			const refusal = await refusalOf(
				tool.apiActions.download_model!.handler({
					options: { model: KNOWN_CATALOG_MODEL },
					principal: admin,
					userId: 1,
				} as unknown as ToolActionContext),
			);
			expect(refusal.code).toBe('tool.unsupported_target');
			expect(String(refusal.publicMessage)).toContain('repair it instead');
			expect(String(refusal.publicMessage)).not.toContain('already installed');
		} finally {
			rmSync(`${SOURCES_STORE}/${KNOWN_CATALOG_MODEL}`, { recursive: true, force: true });
		}
	});
});

/**
 * THE DEGRADED-ANSWER CONTRACT of get_model_sources — the hinge every refusal
 * and every remedy pivots on.
 *
 * A catalog read can fail: the tool config lives in the database. What the
 * server then puts on the wire decides what an archivist is told, and the two
 * possible sentences are not equally wrong — they are opposite. `installed: []`
 * MEANS "nothing is installed" (the client greys the model out, refuses the run
 * and offers a Download the server then contradicts); an ABSENT field means
 * "this server cannot tell", and every consumer keeps its permissive behaviour.
 *
 * Driven through the pure `buildModelSourcesPayload`, so the catch path is
 * gated without a database and without a mock that could leak into another file.
 */
describe('the degraded answer: absent means "cannot tell", never "none"', () => {
	const base = { model_host: '/dedalo/ai_models/', allow_hub: false, store_ready: true };

	test('an unreadable catalog OMITS installed / models / diarization', () => {
		const payload = buildModelSourcesPayload({ readable: false, asr: [], diarization: [] }, base);

		// Not "present and empty" — ABSENT. `in` is the assertion that matters:
		// JSON.stringify drops undefined, so an absent key is what reaches the wire.
		expect('installed' in payload).toBe(false);
		expect('models' in payload).toBe(false);
		expect('diarization' in payload).toBe(false);
		// What is still knowable is still answered: these come from config and the
		// filesystem, not from the catalog.
		expect(payload.model_host).toBe('/dedalo/ai_models/');
		expect(payload.store_ready).toBe(true);
	});

	test('a readable catalog with no models answers EMPTY — a real "none"', () => {
		const payload = buildModelSourcesPayload({ readable: true, asr: [], diarization: [] }, base);
		expect(payload.installed).toEqual([]);
		expect(payload.models).toEqual([]);
		// null = this install declares no speaker detection. Also a real answer.
		expect(payload.diarization).toBeNull();
	});
});

/**
 * THE GUARD MUST NOT OUTLIVE THE JOB IT GUARDS.
 *
 * `repairsInFlight` used to be a bare flag cleared by the repair job's own
 * `finally` — which never runs when the job is CANCELLED WHILE STILL QUEUED:
 * MediaJobManager.run finishes it 'stopped' without invoking the worker at all.
 * Cancelling a queued job is a first-class button in the jobs UI, so one press
 * left that model answering "a repair is already running" forever, with no
 * recovery short of a server restart.
 *
 * The claim is now keyed on the JOB's liveness, so a job that is stopped (or
 * failed, or died) releases the model whoever forgot to clear what.
 */
describe('a cancelled repair job does not lock the model out', () => {
	const KNOWN = 'onnx-community/whisper-large-v3-turbo';
	const admin = { isGlobalAdmin: true } as unknown as ToolActionContext['principal'];

	test('a repair whose queued job was stopped leaves the model repairable', async () => {
		// A REAL job record, stopped before its worker could run — exactly what the
		// jobs UI's cancel button does to a queued job. Nothing else reaches the
		// worker, so nothing else clears a flag.
		const record = mediaJobs.submit(
			'test_repair_guard',
			async () => {
				throw new Error('the worker must never run for a job stopped while queued');
			},
			{ lane: 'transcription' },
		);
		mediaJobs.stop(record.id);

		const schedule: ScheduleRepair = () => ({
			...ok(true, { requestId: 'tool-transcription-test' }),
			job_id: record.id,
			background_job_id: record.id,
		});
		const request = () =>
			repairModelAction(
				{ options: { model: KNOWN }, principal: admin, userId: 1 } as unknown as ToolActionContext,
				schedule,
			);

		try {
			expect((await request()).ok).toBe(true);
			// The job never ran, and never will: it is 'stopped'.
			expect(mediaJobs.status(record.id)?.status).toBe('stopped');

			// The model is repairable again — the claim was released by the job's
			// own death, not by anybody remembering to clear a flag (a second
			// refusal would THROW resource.conflict, so a plain success proves it).
			const second = await request();
			expect(second.ok).toBe(true);
		} finally {
			releaseModelRepairLock(KNOWN);
		}
	});

	test('a LIVE job still refuses a second repair, and download shares the guard', async () => {
		// The guard must still guard: a job the registry considers live blocks both
		// write actions on that model (they write the same files).
		let release: (() => void) | null = null;
		const record = mediaJobs.submit(
			'test_repair_guard_live',
			async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return true;
			},
			{ lane: 'transcription' },
		);
		const schedule: ScheduleRepair = () => ({
			...ok(true, { requestId: 'tool-transcription-test' }),
			job_id: record.id,
			background_job_id: record.id,
		});
		try {
			const first = await repairModelAction(
				{ options: { model: KNOWN }, principal: admin, userId: 1 } as unknown as ToolActionContext,
				schedule,
			);
			expect(first.ok).toBe(true);

			const second = await refusalOf(
				repairModelAction(
					{
						options: { model: KNOWN },
						principal: admin,
						userId: 1,
					} as unknown as ToolActionContext,
					schedule,
				),
			);
			expect(second.code).toBe('resource.conflict');
			expect(second.message).toContain('already running');

			// download_model is the OTHER writer of the same files: same guard.
			const download = await refusalOf(
				tool.apiActions.download_model!.handler({
					options: { model: KNOWN },
					principal: admin,
					userId: 1,
				} as unknown as ToolActionContext),
			);
			expect(download.code).toBe('resource.conflict');
			expect(download.message).toContain('already running');
		} finally {
			if (release !== null) (release as () => void)();
			mediaJobs.stop(record.id);
			releaseModelRepairLock(KNOWN);
		}
	});
});

/**
 * Gate: the tool's UI strings. Every label key this tool's client asks for must
 * exist in the register SEED, in every language the seed already speaks.
 *
 * The failure this stops is silent and permanent: `get_tool_label('x')` returns
 * null for an unseeded key and every call site is written
 * `get_tool_label('x') || 'English literal'`, so the string still RENDERS — in
 * English, for every operator on the install, forever. Nothing throws, nothing
 * logs, and the only symptom is one line of a translated panel that is not
 * translated. When this gate was first written it found 49 such keys.
 *
 * (!) THE KEY SURFACE IS NOT JUST THE LITERAL CALLS. Half of this tool's strings
 * are reached through key TABLES — MODEL_STATES and FAILURE_RULES in
 * transcription_report.js name their words as `state_key`/`message_key`/
 * `cause_key`/`action_key`, ACTION_LABELS keys its remedies, and the worker posts
 * a `label_key` with each degradation warning — and the call site is then
 * `get_tool_label(info.state_key)`, which a scan for `get_tool_label('…')` cannot
 * see. Thirty of the forty-nine gaps lived in exactly that blind spot, so the
 * extraction below reads the tables too. A NEW indirection needs a new pattern
 * here, or it re-opens the hole.
 */
describe('tool_transcription labels', () => {
	const TOOL_DIR = `${import.meta.dir}/../../tools/tool_transcription`;
	const LABELS_TIPO = 'dd1372';
	const SOURCES = [
		'js/tool_transcription.js',
		'js/render_tool_transcription.js',
		'js/render_transcription_status.js',
		'js/transcription_report.js',
		'transcribers/browser_whisper/browser_whisper.js',
	];

	type LabelItem = { lang: string; name: string; value: string };

	async function seedLabels(): Promise<LabelItem[]> {
		const register = JSON.parse(await Bun.file(`${TOOL_DIR}/register.json`).text());
		const value = register.misc?.[LABELS_TIPO]?.[0]?.value;
		expect(Array.isArray(value)).toBe(true);
		return value as LabelItem[];
	}

	/**
	 * The label keys the client actually asks for, read off the tool's own JS —
	 * the client is the source of demand, so the list is extracted, never restated.
	 */
	async function requestedKeys(): Promise<string[]> {
		const keys = new Set<string>();
		const patterns = [
			// get_tool_label('x') — the direct calls
			/get_tool_label\(\s*'([a-z0-9_]+)'/g,
			// label('x', 'fallback') — the panel's own thin wrapper
			/\blabel\(\s*'([a-z0-9_]+)'\s*,/g,
			// the key TABLES: MODEL_STATES, FAILURE_RULES, the worker's warnings
			/(?:message_key|cause_key|action_key|state_key|label_key|role_key)\s*[:=]\s*'([a-z0-9_]+)'/g,
			// post_warning('x', …) — the worker names its own degradation labels
			/post_warning\(\s*'([a-z0-9_]+)'/g,
			// the plural/singular pair the worker chooses between inline
			/\?\s*'(warning_[a-z0-9_]+)'\s*:\s*'(warning_[a-z0-9_]+)'/g,
		];
		for (const file of SOURCES) {
			const source = await Bun.file(`${TOOL_DIR}/${file}`).text();
			for (const pattern of patterns) {
				for (const match of source.matchAll(pattern)) {
					for (const captured of match.slice(1)) {
						if (captured !== undefined) keys.add(captured);
					}
				}
			}
			// ACTION_LABELS: the remedy words, keyed by the same action_key strings
			const table = source.match(/ACTION_LABELS\s*=\s*\{([\s\S]*?)\n\}/);
			if (table !== null) {
				for (const match of mustGet(table[1], 'ACTION_LABELS body').matchAll(
					/^\s*([a-z0-9_]+)\s*:/gm,
				)) {
					keys.add(mustGet(match[1], 'action label key'));
				}
			}
		}
		return [...keys].sort();
	}

	test('the extraction sees the indirect key tables, not just the literal calls', async () => {
		// A guard on the GATE: if a pattern above stops matching, the two tests
		// below go quietly green on a shrunken surface. These four keys are each
		// reached through a different indirection and none is ever written as
		// get_tool_label('…') — they are the canary for each pattern.
		const keys = await requestedKeys();
		expect(keys).toContain('state_unverified'); // MODEL_STATES.state_key
		expect(keys).toContain('cause_model_damaged'); // FAILURE_RULES.cause_key
		expect(keys).toContain('action_repair_model'); // ACTION_LABELS
		expect(keys).toContain('warning_fallback_cpu'); // the worker's post_warning
		expect(keys.length).toBeGreaterThan(80);
	});

	test('every label the client asks for is in the seed', async () => {
		const labels = await seedLabels();
		const defined = new Set(labels.map((item) => item.name));
		const missing = (await requestedKeys()).filter((key) => !defined.has(key));
		expect(missing).toEqual([]);
	});

	test('every label is translated into every language the seed speaks', async () => {
		const labels = await seedLabels();
		const langs = [...new Set(labels.map((item) => item.lang))].sort();
		expect(langs.length).toBeGreaterThan(1); // a one-lang seed would pass vacuously

		const byName = new Map<string, Set<string>>();
		for (const item of labels) {
			const langsForName = byName.get(item.name) ?? new Set<string>();
			langsForName.add(item.lang);
			byName.set(item.name, langsForName);
		}

		const gaps = [...byName.entries()]
			.map(([name, present]) => ({ name, missing: langs.filter((lang) => !present.has(lang)) }))
			.filter((entry) => entry.missing.length > 0);
		expect(gaps).toEqual([]);
	});

	test('no label is defined twice for the same language', async () => {
		const labels = await seedLabels();
		const seen = new Set<string>();
		const duplicates: string[] = [];
		for (const item of labels) {
			const key = `${item.name}/${item.lang}`;
			if (seen.has(key)) duplicates.push(key);
			seen.add(key);
		}
		expect(duplicates).toEqual([]);
	});

	test('a label with a {count} placeholder keeps it in every language', async () => {
		// The worker substitutes {count} into the plural warning; a translation
		// that drops the placeholder renders "fragments of the recording were
		// skipped" with no number in it, which is not the fact being reported.
		const labels = await seedLabels();
		const withCount = labels.filter((item) => item.name === 'warning_windows_skipped');
		expect(withCount.length).toBeGreaterThan(1);
		for (const item of withCount) {
			expect(item.value).toContain('{count}');
		}
	});
});

/**
 * Gate: every severity the panel can EMIT has a rule that paints it.
 *
 * The panel writes `severity_<x>` onto each row (render_transcription_status.js)
 * and the tool's LESS names the ones that get an accent. A severity added to
 * REPORT_SEVERITIES with no rule beside it does not fail anywhere — it renders in
 * the neutral default, which is precisely how "Transcription completed." came to
 * arrive in the same grey as "the model is unverified".
 *
 * `info` is the deliberate exception and is asserted as such: it IS the neutral
 * default, and `progress` never reaches a row (it is the transient line, a node
 * of its own). Everything else must be painted.
 */
describe('tool_transcription status severities', () => {
	const TOOL_DIR = `${import.meta.dir}/../../tools/tool_transcription`;
	const UNPAINTED = ['info', 'progress'];

	async function severities(): Promise<string[]> {
		const source = await Bun.file(`${TOOL_DIR}/js/transcription_report.js`).text();
		const match = source.match(/REPORT_SEVERITIES\s*=\s*\[([^\]]*)\]/);
		expect(match).not.toBeNull();
		return [...mustGet(match, 'REPORT_SEVERITIES')[1]!.matchAll(/'([a-z_]+)'/g)].map((m) =>
			mustGet(m[1], 'severity'),
		);
	}

	test('the panel prefixes the class, so no severity can collide with a global utility', async () => {
		// `error` and `warning` are page-wide utility classes (general.less gives
		// `.error` a red slab AND `color: white !important`). A row that wore the
		// bare word inherited that white and rendered invisible on the panel's own
		// light surface — the reason for the prefix, restated as a test.
		const source = await Bun.file(`${TOOL_DIR}/js/render_transcription_status.js`).text();
		expect(source).toContain('status_report severity_${report.severity}');
		expect(source).toContain("readiness_line severity_${line.severity || 'info'}");
	});

	test('every emittable severity is painted in the tool css', async () => {
		const less = await Bun.file(`${TOOL_DIR}/css/tool_transcription.less`).text();
		const unpainted = (await severities())
			.filter((severity) => !UNPAINTED.includes(severity))
			.filter((severity) => !less.includes(`&.severity_${severity}`));
		expect(unpainted).toEqual([]);
	});

	test('the built css carries those rules, not only the source', async () => {
		// The .css is a committed artifact (bun run css:build): a rule that exists
		// only in the .less is a rule the browser never sees.
		const css = await Bun.file(`${TOOL_DIR}/css/tool_transcription.css`).text();
		const unbuilt = (await severities())
			.filter((severity) => !UNPAINTED.includes(severity))
			.filter((severity) => !css.includes(`.severity_${severity}`));
		expect(unbuilt).toEqual([]);
	});
});

/**
 * Gate: the readiness line states facts a reader can act on.
 *
 * Both defects this pins were the same mistake in opposite directions — a line
 * that says too much and a line that says too little:
 *
 *  - the language read `Castellano | lg-spa | es`: one fact spelled three times,
 *    twice for a machine. And the third part is OPTIONAL — a project lang with no
 *    ISO 639-1 code (most minority and historical langs) put the literal word
 *    "undefined" in the panel whose whole job is to state what is true;
 *  - the model read `Model: unverified`, naming no model, beside a remedy button
 *    that acts on one.
 *
 * The codes did not disappear: they moved to the row's `title` (render layer), so
 * the administrator keeps them and the archivist stops reading them.
 */
describe('tool_transcription readiness facts', () => {
	const SOURCE = `${import.meta.dir}/../../tools/tool_transcription/js/tool_transcription.js`;

	type LangEntry = { value: string; label: string; tld2?: string };
	type LangProbe = {
		get_current_lang_info: (lang: string) => string;
		get_lang_label: (lang: string) => string;
	};

	// its OWN directory, not ROOT: ROOT is shared with the media half of this
	// file, which creates and removes trees under it while these tests run.
	const LANG_PROBE_DIR = scratchDir('lang_probe');
	afterAll(() => removeScratchDir(LANG_PROBE_DIR));

	/**
	 * The two functions, run as the REAL bytes that ship — sliced out of the
	 * client source rather than re-implemented here.
	 *
	 * (!) SLICED, not imported. tool_transcription.js cannot be loaded in
	 * isolation the way render_tool_transcription.js can: its module body
	 * evaluates `tool_common.prototype`, `common`, `render_tool_transcription`…,
	 * so stripping the imports leaves a chain of free identifiers that would have
	 * to be stubbed — a harness that breaks whenever the tool grows a dependency,
	 * testing the stubs as much as the code. The `}//end <name>` terminator is
	 * this codebase's convention and is asserted below, so a slice that stops
	 * matching FAILS rather than silently testing nothing.
	 */
	async function loadLangProbe(langs: LangEntry[]): Promise<LangProbe> {
		const raw = await Bun.file(SOURCE).text();
		const slices: string[] = [];
		for (const name of ['get_current_lang_info', 'get_lang_label']) {
			const from = raw.indexOf(`export const ${name} = function(`);
			const to = raw.indexOf(`}//end ${name}`, from);
			if (from === -1 || to === -1) {
				throw new Error(`lang harness: could not slice ${name} — the source shape changed`);
			}
			slices.push(raw.slice(from, to + 1).replace('export const', 'const'));
		}
		const dir = LANG_PROBE_DIR;
		const probe = `${dir}/lang_info_${langs.length}.probe.mjs`;
		await Bun.write(
			probe,
			`export const make = function( page_globals ) {\n${slices.join('\n')}\nreturn { get_current_lang_info, get_lang_label }\n}\n`,
		);
		const module = (await import(probe)) as {
			make: (globals: { dedalo_projects_default_langs: LangEntry[] }) => LangProbe;
		};
		return module.make({ dedalo_projects_default_langs: langs });
	}

	test('a lang with no 2-letter code never renders the word "undefined"', async () => {
		const probe = await loadLangProbe([
			{ value: 'lg-spa', label: 'Castellano', tld2: 'es' },
			{ value: 'lg-cha', label: 'Chamorro' }, // declared with no tld2
		]);
		expect(probe.get_current_lang_info('lg-spa')).toBe('Castellano | lg-spa | es');
		expect(probe.get_current_lang_info('lg-cha')).toBe('Chamorro | lg-cha');
		expect(probe.get_current_lang_info('lg-cha')).not.toContain('undefined');
	});

	test('the readable name is the label alone, and an unknown lang still names something', async () => {
		const probe = await loadLangProbe([{ value: 'lg-spa', label: 'Castellano', tld2: 'es' }]);
		expect(probe.get_lang_label('lg-spa')).toBe('Castellano');
		// never empty and never 'undefined': the tag itself is a truthful fallback
		expect(probe.get_lang_label('lg-xxx')).toBe('lg-xxx');
	});

	test('the model line names its model, and the language line drops the codes', async () => {
		// The two lines are built inside refresh_readiness, which needs the whole
		// tool DOM to run; what is pinned here is that neither reverts to the shape
		// it had — the model line composed from `readiness_model` alone, the
		// language line rendering the full triple as its text.
		const client = await Bun.file(
			`${import.meta.dir}/../../tools/tool_transcription/js/render_tool_transcription.js`,
		).text();
		expect(client).toContain('const model_words = function()');
		expect(client).toContain(
			"text\t\t: `${self.get_tool_label('readiness_language') || 'Language'}: ${get_lang_label(",
		);
		expect(client).not.toContain("|| 'Language'}: ${get_current_lang_info(");
		// the codes are kept, on the row's title
		expect(client).toContain('title\t\t: get_current_lang_info(');
	});
});

/**
 * Gate: an interrupted browser run is not lost, and not silently overwritten.
 *
 * A browser transcription lives in the tool's tab: ⌘R kills the worker mid-window.
 * Every completed window was already persisted, so the WORK survived — but the
 * store was read in one place only, inside the run and after the trigger was
 * pressed, so the archivist came back to a tool that looked untouched.
 *
 * Worse, the store was ONE SLOT — `{segments, model}` — with the resume gated on
 * `saved.model===selected`. That read as "another model's partial is ignored". It
 * was not ignored: the next run's FIRST completed window overwrote the slot, so an
 * hour recognised under `small` died at window one of a `medium` run, before
 * anything could ask. A slot PER MODEL is what makes the choice the archivist's,
 * and is what these tests pin.
 */
describe('tool_transcription interrupted-run recovery', () => {
	const TOOL_DIR = `${import.meta.dir}/../../tools/tool_transcription`;

	type Entry = { segments: unknown[]; updated?: number };
	type PartialProbe = {
		read_partials: (stored: unknown) => Record<string, Entry>;
		resume_seconds_of: (segments: unknown[]) => number;
	};

	/** The real bytes, sliced — see the lang probe above for why not imported. */
	const PARTIAL_PROBE_DIR = scratchDir('partial_probe');

	async function loadPartialProbe(): Promise<PartialProbe> {
		const raw = await Bun.file(`${TOOL_DIR}/js/tool_transcription.js`).text();
		const slices: string[] = [];
		for (const name of ['read_partials', 'resume_seconds_of']) {
			const from = raw.indexOf(`export const ${name} = function(`);
			const to = raw.indexOf(`}//end ${name}`, from);
			if (from === -1 || to === -1) {
				throw new Error(`partial harness: could not slice ${name} — the source shape changed`);
			}
			slices.push(raw.slice(from, to + 1));
		}
		const dir = PARTIAL_PROBE_DIR;
		const probe = `${dir}/partials.probe.mjs`;
		await Bun.write(probe, slices.join('\n'));
		return (await import(probe)) as unknown as PartialProbe;
	}

	afterAll(() => removeScratchDir(PARTIAL_PROBE_DIR));

	test('two models keep two partials — neither can overwrite the other', async () => {
		const probe = await loadPartialProbe();
		const partials = probe.read_partials({
			partials: {
				'Xenova/whisper-small': { segments: [{ start: 0, end: 2530 }], updated: 10 },
				'Xenova/whisper-medium': { segments: [{ start: 0, end: 90 }], updated: 20 },
			},
		});
		expect(Object.keys(partials).sort()).toEqual(['Xenova/whisper-medium', 'Xenova/whisper-small']);
		// and the cursor offered is the one the worker will actually resume from
		expect(probe.resume_seconds_of(partials['Xenova/whisper-small']!.segments)).toBe(2530);
	});

	test('a partial saved before the per-model store still resumes', async () => {
		// The legacy single slot. An archivist whose run was interrupted the day
		// before this change must not lose it to the migration.
		const probe = await loadPartialProbe();
		const partials = probe.read_partials({
			segments: [{ start: 0, end: 42 }],
			model: 'Xenova/whisper-small',
			updated: 7,
		});
		expect(Object.keys(partials)).toEqual(['Xenova/whisper-small']);
		expect(probe.resume_seconds_of(partials['Xenova/whisper-small']!.segments)).toBe(42);
	});

	test('an empty or absent store offers nothing, and never throws', async () => {
		const probe = await loadPartialProbe();
		expect(probe.read_partials(null)).toEqual({});
		expect(probe.read_partials({})).toEqual({});
		// a slot emptied by a finished run is not an offer to resume
		expect(probe.read_partials({ partials: { 'a/b': { segments: [], updated: 1 } } })).toEqual({});
		// the legacy shape, already cleared
		expect(probe.read_partials({ segments: [], model: null })).toEqual({});
	});

	test('the run writes its own slot only, and finish clears only its own', async () => {
		const source = await Bun.file(`${TOOL_DIR}/js/tool_transcription.js`).text();
		// the whole-record write that destroyed the other model's work is gone
		expect(source).not.toContain('segments	: data.segments,');
		expect(source).not.toContain('segments: [], model: null');
		expect(source).toContain('save_partial( data.segments )');
		expect(source).toContain('save_partial( undefined )');
		// and the run reads its own slot, never "whatever was saved last"
		expect(source).toContain('stored_partials[transcriber_quality]');
	});

	test('the readiness panel reads the store, and by the same key the run writes', async () => {
		// The defect was not the store: it was that nothing READ it until the
		// button had already been pressed. And one spelling of the key, shared —
		// two spellings is a store that silently never matches.
		const client = await Bun.file(`${TOOL_DIR}/js/render_tool_transcription.js`).text();
		expect(client).toContain('read_partials(');
		expect(client).toContain('partial_id(self)');
		expect(client).toContain("action_key		: 'action_resume'");
		expect(client).toContain("action_key		: 'action_use_saved_model'");

		const source = await Bun.file(`${TOOL_DIR}/js/tool_transcription.js`).text();
		expect(source).toContain('const resume_id = partial_id( self )');
	});

	test('both new remedies are pressable, or they render as a dead sentence', async () => {
		// A readiness line offering a remedy that is not in PRESSABLE_ACTIONS
		// renders as text with no button — the offer would be made and not honoured.
		const panel = await Bun.file(`${TOOL_DIR}/js/render_transcription_status.js`).text();
		const pressable = panel.match(/PRESSABLE_ACTIONS\s*=\s*\[([^\]]*)\]/);
		expect(mustGet(pressable, 'PRESSABLE_ACTIONS')[1]).toContain('action_resume');
		expect(mustGet(pressable, 'PRESSABLE_ACTIONS')[1]).toContain('action_use_saved_model');
		// …and each is actually handled, or the press does nothing at all
		const client = await Bun.file(`${TOOL_DIR}/js/render_tool_transcription.js`).text();
		expect(client).toContain("case 'action_resume':");
		expect(client).toContain("case 'action_use_saved_model':");
	});

	test('the unload guard is armed for a browser run and disarmed by every exit', async () => {
		const source = await Bun.file(`${TOOL_DIR}/js/tool_transcription.js`).text();
		expect(source).toContain('arm_unload_guard()');
		// disarmed in BOTH: end_run (the paths that fail before a WAV exists) and
		// delete_audio (finish resolves to the caller without passing end_run, so
		// a guard removed only there would outlive the run).
		const endRun = source.indexOf('const end_run = function() {');
		const deleteAudio = source.indexOf('const delete_audio = function() {');
		expect(source.slice(endRun, endRun + 200)).toContain('disarm_unload_guard()');
		expect(source.slice(deleteAudio, deleteAudio + 500)).toContain('disarm_unload_guard()');
		// the SERVER engine keeps no guard: that job survives the reload and
		// get_server_status re-polls it, so a warning there would be a lie.
		const serverRun = source.indexOf('automatic_transcription_server = async function');
		expect(source.slice(serverRun, serverRun + 3000)).not.toContain('arm_unload_guard');
	});
});
