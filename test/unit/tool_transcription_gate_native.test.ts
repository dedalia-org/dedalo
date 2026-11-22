/**
 * TOOLS-3 (closure Step 3) — tool_transcription's record doors go through the
 * write door: the (section, COMPONENT) pair + the section floor + the record
 * scope, on BOTH lifted ddos, UNCONDITIONALLY, before any validation, any
 * config lookup, any ASR call and any file.
 *
 * WHAT WAS WRONG (measured at 45b8c45162, tools/tool_transcription/server/index.ts):
 *   - `gateRecord` ran the `record` kind — the SECTION level + scope. The media
 *     component_tipo in the ddo was never consulted: a profile holding the
 *     section but explicitly 0 on the AV built and deleted its WAV, submitted
 *     its audio to the ASR server and polled it;
 *   - `check_server_transcriber_status` gated ONLY when media_ddo.section_tipo
 *     was present — a payload without it reached the transcriber config lookup
 *     ungated;
 *   - `build_subtitles_file` gated ONLY when both tipos were present, and never
 *     gated the RELATED AV whose duration it reads and whose media folder it
 *     writes the VTT into — a transcript-writer with 0 on the AV wrote files
 *     into the AV's tree;
 *   - `automatic_transcription` never required the WRITE target's
 *     component_tipo, so its write gate was section-only by construction;
 *   - the background save re-checked nothing: a grant revoked between enqueue
 *     and completion still wrote the transcript.
 *
 * ONE LEVEL ON THE AV, ON EVERY PATH (round 6): the AV is only ever a SOURCE —
 * the browser-ASR WAV, the local engine's WAV, the remote engine's `audio`
 * quality and the VTT's duration are all derived from it — so every path asks
 * READ (1) on it and WRITE (2) only on the transcript. The TRANSCRIBER identity
 * (AV 1, transcript 2) gets the SAME answer (past the gate) from every door; the
 * TEXT_ONLY one (AV 0) the same refusal ON the AV from every door.
 *
 * THE LOCAL ACTION SET IS PINNED EXACTLY (key equality against
 * `tool.apiActions`): every action is either a RECORD door (a payload builder
 * below) or an enumerated install-level exemption (admin-only /
 * configuration) with its reason. A new action that is neither reddens the
 * pin. The cross-tool door census — derived from every loaded tool — is owned
 * by authz_door_matrix_native, which classifies these same actions probed or
 * NOT_YET_PROBED; this pin is the per-tool half, not a second census.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { subtitlesPath } from '../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import * as save_component from '../../src/core/section/record/save_component.ts';
import { getPermissions, type Principal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { checkServerTranscriberStatus, tool } from '../../tools/tool_transcription/server/index.ts';
import { issuePollHandle } from '../../tools/tool_transcription/server/poll_handle.ts';
import {
	AUTHZ_AV,
	AUTHZ_PROJECT_P,
	AUTHZ_PROJECT_Q,
	AUTHZ_SECTION,
	AUTHZ_SECTION_ONLY_USER_ID,
	AUTHZ_SUBTITLE_TEXT_AREA,
	AUTHZ_TEXT_AREA,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	authzProfileId,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { refusalOf } from '../helpers/refusal.ts';

/** test3's section_group the scratch text area hangs under (as test17 does). */
const GROUPER = 'test45';
const SUBTITLE_TEXT = 'zzauthz subtitle source text, long enough to cut into a cue.';
const LANG = 'lg-eng';

const SUBTITLE_SITUATION = situation({
	tld: 'zzauthz',
	name: 'tool_transcription_gate (text_area related to test94)',
	nodes: [
		{
			tipo: AUTHZ_SUBTITLE_TEXT_AREA,
			parent: GROUPER,
			model: 'component_text_area',
			term: { 'lg-eng': 'zzauthz transcript (related to the AV)' },
			is_translatable: true,
			relations: [{ tipo: AUTHZ_AV }],
		},
	],
});

/** The install-level actions: no record is addressed (admin-only or configuration). */
const INSTALL_LEVEL_EXEMPT: Record<string, string> = {
	get_model_sources: 'install configuration only — no record addressed, nothing written',
	download_model: 'isGlobalAdmin — install-wide model store write, no record addressed',
	verify_model: 'isGlobalAdmin — reports install-wide model state, no record addressed',
	repair_model: 'isGlobalAdmin — install-wide model store repair, no record addressed',
};

let ids: AuthzIdentities;
let recordId = 0;
/** A test3 record in PROJECT_Q — out of every in-scope identity's scope. */
let outOfScopeRecordId = 0;
/** A record whose transcript ONLY the background-save legs write (starts empty). */
let backgroundRecordId = 0;

const media = () => ({
	component_tipo: AUTHZ_AV,
	section_tipo: AUTHZ_SECTION,
	section_id: recordId,
});
const transcript = () => ({
	component_tipo: AUTHZ_TEXT_AREA,
	section_tipo: AUTHZ_SECTION,
	section_id: recordId,
});

/** One payload per RECORD door — the payload an authorized caller would send. */
const RECORD_DOORS: Record<string, () => Record<string, unknown>> = {
	create_transcribable_audio_file: () => ({ media_ddo: media() }),
	delete_transcribable_audio_file: () => ({ media_ddo: media() }),
	automatic_transcription: () => ({
		media_ddo: media(),
		transcription_ddo: transcript(),
		source_lang: LANG,
		transcriber_quality: 'audio',
		transcriber_engine: 'babel_transcriber',
	}),
	check_server_transcriber_status: () => ({
		media_ddo: media(),
		transcriber_engine: 'babel_transcriber',
		pid: 123,
	}),
	// The scratch transcript RELATED to the AV (test17 has no AV relation): a
	// door that let a refused identity through would really write the VTT.
	build_subtitles_file: () => ({
		section_tipo: AUTHZ_SECTION,
		component_tipo: AUTHZ_SUBTITLE_TEXT_AREA,
		section_id: recordId,
		lang: LANG,
		max_charline: 40,
	}),
};

const contextFor = (principal: Principal, options: Record<string, unknown>): ToolActionContext =>
	({ principal, userId: principal.userId, options, background: false }) as ToolActionContext;

function handlerOf(action: string) {
	const spec = tool.apiActions[action];
	if (spec === undefined) throw new Error(`tool_transcription has no action ${action}`);
	return spec.handler;
}

/** Counting seams for the status poll: config / provider / media resolution. */
function countingSeams(answer: unknown = { status: 2 }) {
	const calls = { config: 0, provider: 0, media: 0, polledPids: [] as unknown[] };
	return {
		calls,
		seams: {
			transcriberConfig: async () => {
				calls.config++;
				return { uri: 'http://zzauthz.invalid/api/', key: 'zzauthz-key' };
			},
			statusProvider: () => {
				calls.provider++;
				return {
					provider: async (req: { pid: unknown }) => {
						calls.polledPids.push(req.pid);
						return answer;
					},
					error: null,
				} as never;
			},
			mediaContext: (async (input: Parameters<typeof resolveMediaToolContext>[0]) => {
				calls.media++;
				return resolveMediaToolContext(input);
			}) as typeof resolveMediaToolContext,
		},
	};
}

describe.if(DB_READY)('TOOLS-3 — tool_transcription record doors through the write door', () => {
	let vttPath = '';
	/** The FIRST directory this gate created on the way to the subtitles folder (swept after). */
	let createdVttRoot: string | undefined;

	beforeAll(async () => {
		await ensureSituation(SUBTITLE_SITUATION);
		await installAuthzDoorFixture();
		recordId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P, [
			{
				tipo: AUTHZ_SUBTITLE_TEXT_AREA,
				lang: LANG,
				value: [{ id: 1, lang: LANG, value: SUBTITLE_TEXT }],
			},
		]);
		outOfScopeRecordId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_Q);
		backgroundRecordId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
		ids = await resolveAuthzIdentities();
		// The AV's subtitles folder EXISTS (build_subtitles_file never creates it),
		// inside the ARMED suite media root — so a door that lets the text-only
		// caller through really does write a VTT here, and the gate sees it.
		const { identity, pathOpts } = await resolveMediaToolContext({
			component_tipo: AUTHZ_AV,
			section_tipo: AUTHZ_SECTION,
			section_id: recordId,
		});
		vttPath = subtitlesPath(identity, LANG, pathOpts.mediaRoot);
		createdVttRoot = mkdirSync(dirname(vttPath), { recursive: true });
		rmSync(vttPath, { force: true });
	});

	afterAll(async () => {
		if (vttPath !== '') rmSync(vttPath, { force: true });
		if (createdVttRoot !== undefined) rmSync(createdVttRoot, { recursive: true, force: true });
		await removeAuthzDoorFixture();
		expect(await dropSituation(SUBTITLE_SITUATION)).toBe(0);
	});

	test('the action set is pinned exactly: every action is a record door or an enumerated exemption', () => {
		const classified = [...Object.keys(RECORD_DOORS), ...Object.keys(INSTALL_LEVEL_EXEMPT)].sort();
		expect(Object.keys(tool.apiActions).sort()).toEqual(classified);
	});

	test('the contrast is live (guards every leg)', async () => {
		await assertAuthzDoorContrast(ids);
		expect(recordId).toBeGreaterThan(0);
	});

	for (const action of Object.keys(RECORD_DOORS)) {
		describe(action, () => {
			test('NO_COMPONENT (section 2, the component an explicit 0) → perm.denied', async () => {
				const refusal = await refusalOf(
					handlerOf(action)(contextFor(ids.sectionOnly, RECORD_DOORS[action]?.() ?? {})),
				);
				expect(refusal.code).toBe('perm.denied');
				// The one door whose effect this gate CAN observe (the VTT beside the AV,
				// whose folder exists; the CONTROL leg below proves the write happens):
				// every other door's effect needs an AV original the suite does not hold,
				// so its leg claims the refusal code and nothing more.
				if (action === 'build_subtitles_file') expect(existsSync(vttPath)).toBe(false);
			});

			test('OUT_OF_SCOPE (every grant, another project) → perm.out_of_scope (the scope code, not a generic denial)', async () => {
				const refusal = await refusalOf(
					handlerOf(action)(contextFor(ids.outOfScope, RECORD_DOORS[action]?.() ?? {})),
				);
				expect(refusal.code).toBe('perm.out_of_scope');
			});
		});
	}

	test('check_server_transcriber_status: NO_COMPONENT costs zero config / provider / media calls', async () => {
		const { calls, seams } = countingSeams();
		await refusalOf(
			checkServerTranscriberStatus(
				contextFor(ids.sectionOnly, RECORD_DOORS.check_server_transcriber_status?.() ?? {}),
				seams,
			),
		);
		expect({ config: calls.config, provider: calls.provider, media: calls.media }).toEqual({
			config: 0,
			provider: 0,
			media: 0,
		});
	});

	test('check_server_transcriber_status: a media_ddo WITHOUT section_tipo is a GATE refusal, zero config calls', async () => {
		const { calls, seams } = countingSeams();
		const refusal = await refusalOf(
			checkServerTranscriberStatus(
				contextFor(ids.control, {
					media_ddo: { component_tipo: AUTHZ_AV, section_id: recordId },
					transcriber_engine: 'babel_transcriber',
					pid: 123,
				}),
				seams,
			),
		);
		expect(refusal.code).toBe('request.invalid');
		expect(calls.config).toBe(0);
	});

	// ── the poll reaches ONLY the caller's own job, and returns only its status ─
	// (TOOLS-3 review r7). The `pid` the poll accepts is the handle
	// automatic_transcription issued — bound to the submitting user and the media
	// record. A raw job id, another user's handle, or the caller's handle aimed at
	// another record is answered as "no process" (status 1) with NOTHING looked up
	// or polled; the served twin polls the BOUND job and hands back the status
	// alone — never the finished transcript.
	const handleFor = (userId: number, sectionId: number, pid: string | number = 'job-41') =>
		issuePollHandle({
			pid,
			engine: 'babel_transcriber',
			userId,
			sectionTipo: AUTHZ_SECTION,
			componentTipo: AUTHZ_AV,
			sectionId,
		});
	const pollWith = (pid: unknown, sectionId: number = recordId) => ({
		media_ddo: { ...media(), section_id: sectionId },
		transcriber_engine: 'babel_transcriber',
		pid,
	});
	const FINISHED = {
		status: 3,
		transcription_data: { segments: [{ start: 0, end: 1, text: 'zzauthz restricted words' }] },
	};

	test('check_server_transcriber_status: the CONTROL polls ITS OWN job — the bound id, the status alone (no transcript)', async () => {
		const { calls, seams } = countingSeams(FINISHED);
		const response = await checkServerTranscriberStatus(
			contextFor(ids.control, pollWith(handleFor(ids.control.userId, recordId))),
			seams,
		);
		expect({ data: response.data, config: calls.config, polled: calls.polledPids }).toEqual({
			data: { status: 3 },
			config: 1,
			polled: ['job-41'],
		});
	});

	for (const [label, principal, pid, sectionId] of [
		['a RAW job id (guessed, sequential)', () => ids.control, () => 'job-42', () => recordId],
		[
			"ANOTHER USER's handle, on a record the poller may read",
			() => ids.transcriber,
			() => handleFor(ids.control.userId, recordId),
			() => recordId,
		],
		[
			"the caller's own handle aimed at ANOTHER record",
			() => ids.control,
			() => handleFor(ids.control.userId, recordId),
			() => backgroundRecordId,
		],
		[
			'an ALTERED handle (the seal no longer verifies)',
			() => ids.control,
			() => `${handleFor(ids.control.userId, recordId).slice(0, -2)}xx`,
			() => recordId,
		],
	] as const) {
		test(`check_server_transcriber_status: ${label} → status 1 (no process), NOTHING looked up or polled, no transcript`, async () => {
			const { calls, seams } = countingSeams(FINISHED);
			const who = principal();
			const response = await checkServerTranscriberStatus(
				contextFor(who, pollWith(pid(), sectionId())),
				seams,
			);
			expect({
				data: response.data,
				config: calls.config,
				provider: calls.provider,
				media: calls.media,
			}).toEqual({ data: { status: 1 }, config: 0, provider: 0, media: 0 });
		});
	}

	test('automatic_transcription: a transcription_ddo WITHOUT component_tipo is refused as request.invalid', async () => {
		const options = {
			...(RECORD_DOORS.automatic_transcription?.() ?? {}),
			transcription_ddo: { section_tipo: AUTHZ_SECTION, section_id: recordId },
		};
		const refusal = await refusalOf(
			handlerOf('automatic_transcription')(contextFor(ids.control, options)),
		);
		expect(refusal.code).toBe('request.invalid');
	});

	test('build_subtitles_file: a missing section_tipo / component_tipo is a GATE refusal, not a validation list', async () => {
		for (const drop of ['section_tipo', 'component_tipo'] as const) {
			const options: Record<string, unknown> = {
				...(RECORD_DOORS.build_subtitles_file?.() ?? {}),
				component_tipo: AUTHZ_SUBTITLE_TEXT_AREA,
			};
			delete options[drop];
			const refusal = await refusalOf(
				handlerOf('build_subtitles_file')(contextFor(ids.control, options)),
			);
			expect({ drop, code: refusal.code }).toEqual({ drop, code: 'request.invalid' });
		}
	});

	test('build_subtitles_file: the transcript writable (2) but its AV at 0 → perm.denied, and NO VTT is written', async () => {
		const options = {
			...(RECORD_DOORS.build_subtitles_file?.() ?? {}),
			component_tipo: AUTHZ_SUBTITLE_TEXT_AREA,
		};
		const outcome = await handlerOf('build_subtitles_file')(contextFor(ids.textOnly, options)).then(
			(value) => ({ code: 'served', value }),
			(error: unknown) => ({ code: (error as { code?: string }).code ?? String(error) }),
		);
		const wrote = existsSync(vttPath);
		rmSync(vttPath, { force: true });
		expect({ code: outcome.code, vttWritten: wrote }).toEqual({
			code: 'perm.denied',
			vttWritten: false,
		});
	});

	test('build_subtitles_file: the CONTROL (both halves granted) passes both gates', async () => {
		const options = {
			...(RECORD_DOORS.build_subtitles_file?.() ?? {}),
			component_tipo: AUTHZ_SUBTITLE_TEXT_AREA,
		};
		const outcome = await handlerOf('build_subtitles_file')(contextFor(ids.control, options)).then(
			() => 'served',
			(error: unknown) => (error as { code?: string }).code ?? String(error),
		);
		const wrote = existsSync(vttPath);
		rmSync(vttPath, { force: true });
		expect(outcome.startsWith('perm.')).toBe(false);
		expect(outcome).not.toBe('request.invalid');
		// The effect the refusal legs assert ABSENT is observable: the served door writes it.
		expect({ outcome, wrote }).toEqual({ outcome: 'served', wrote: true });
	});

	// ── one level on the AV, on every path (TOOLS-3 round 6) ────────────────
	// Every door that derives a file from the AV asks READ on it. The typical
	// transcriber (AV 1, transcript 2) is served past the gate by ALL of them —
	// the browser-ASR WAV, the local engine (which builds the SAME WAV), the
	// remote engine and the VTT — and the AV-0 twin is refused ON the AV by all.
	const pastTheGate = (code: string) =>
		!code.startsWith('perm.') && !code.startsWith('request.invalid');
	const outcomeOf = (action: string, principal: Principal, options: Record<string, unknown>) =>
		handlerOf(action)(contextFor(principal, options)).then(
			() => 'served',
			(error: unknown) => (error as { code?: string }).code ?? String(error),
		);
	const AV_PATHS: Record<string, () => Record<string, unknown>> = {
		create_transcribable_audio_file: () => RECORD_DOORS.create_transcribable_audio_file?.() ?? {},
		delete_transcribable_audio_file: () => RECORD_DOORS.delete_transcribable_audio_file?.() ?? {},
		'automatic_transcription (local engine)': () => ({
			...(RECORD_DOORS.automatic_transcription?.() ?? {}),
			transcriber_engine: 'local_whisper',
		}),
		'automatic_transcription (remote engine)': () => RECORD_DOORS.automatic_transcription?.() ?? {},
		build_subtitles_file: () => RECORD_DOORS.build_subtitles_file?.() ?? {},
	};
	test('TRANSCRIBER (AV 1, transcript 2): EVERY AV-deriving door answers past the gate — the same answer', async () => {
		expect(await getPermissions(ids.transcriber, AUTHZ_SECTION, AUTHZ_AV)).toBe(1);
		const answers: Record<string, boolean> = {};
		for (const [label, options] of Object.entries(AV_PATHS)) {
			const code = await outcomeOf(label.split(' ')[0] as string, ids.transcriber, options());
			answers[label] = pastTheGate(code);
		}
		rmSync(vttPath, { force: true });
		expect(answers).toEqual(
			Object.fromEntries(Object.keys(AV_PATHS).map((label) => [label, true])),
		);
	});
	test('TEXT_ONLY (AV 0, transcript 2): EVERY AV-deriving door refuses ON the AV — the same answer', async () => {
		const answers: Record<string, string> = {};
		for (const [label, options] of Object.entries(AV_PATHS)) {
			const refusal = await refusalOf(
				handlerOf(label.split(' ')[0] as string)(contextFor(ids.textOnly, options())),
			);
			answers[label] = `${refusal.code} ON ${String(refusal.coordinates?.tipo)}`;
		}
		expect(answers).toEqual(
			Object.fromEntries(
				Object.keys(AV_PATHS).map((label) => [label, `perm.denied ON ${AUTHZ_AV}`]),
			),
		);
		expect(existsSync(vttPath)).toBe(false);
	});

	// ── the TRANSCRIPT's write level (TOOLS-3 review r7) ────────────────────
	// Every identity above holds the transcript at 2 or 0 — none at 1 — so a
	// transcript leg lowered to READ would stay green. READ_COMPONENT holds the
	// AV AND both transcripts at 1 (the section at 2): it hears the recording and
	// may READ its transcript, and every door that AUTHORS a transcript must
	// refuse it ON that transcript — build_subtitles_file writing the VTT into
	// the AV's subtitles folder included. The WAV doors (a read of the AV) serve it.
	test('READ_COMPONENT (AV 1, transcript READ 1): the transcript-authoring doors refuse ON the transcript, NO VTT is written; the WAV doors serve it', async () => {
		expect(await getPermissions(ids.readComponent, AUTHZ_SECTION, AUTHZ_AV)).toBe(1);
		expect(await getPermissions(ids.readComponent, AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA)).toBe(
			1,
		);
		const refusedOn = async (action: string, options: Record<string, unknown>) => {
			const refusal = await refusalOf(handlerOf(action)(contextFor(ids.readComponent, options)));
			return `${refusal.code} ON ${String(refusal.coordinates?.tipo)} (required ${String(refusal.coordinates?.required)})`;
		};
		rmSync(vttPath, { force: true });
		const answers = {
			build_subtitles_file: await refusedOn(
				'build_subtitles_file',
				RECORD_DOORS.build_subtitles_file?.() ?? {},
			),
			automatic_transcription: await refusedOn(
				'automatic_transcription',
				RECORD_DOORS.automatic_transcription?.() ?? {},
			),
			vttWritten: existsSync(vttPath),
			create_transcribable_audio_file: pastTheGate(
				await outcomeOf(
					'create_transcribable_audio_file',
					ids.readComponent,
					RECORD_DOORS.create_transcribable_audio_file?.() ?? {},
				),
			),
			delete_transcribable_audio_file: pastTheGate(
				await outcomeOf(
					'delete_transcribable_audio_file',
					ids.readComponent,
					RECORD_DOORS.delete_transcribable_audio_file?.() ?? {},
				),
			),
		};
		rmSync(vttPath, { force: true });
		expect(answers).toEqual({
			build_subtitles_file: `perm.denied ON ${AUTHZ_SUBTITLE_TEXT_AREA} (required 2)`,
			automatic_transcription: `perm.denied ON ${AUTHZ_TEXT_AREA} (required 2)`,
			vttWritten: false,
			create_transcribable_audio_file: true,
			delete_transcribable_audio_file: true,
		});
	});

	// ── the SHARED WAV's lifecycle asks the section at WRITE (TOOLS-3 review r8) ─
	// The audio_tr WAV is ONE file per record: deleting it breaks every other
	// user of that record mid-use (a browser-ASR fetch, a local-engine submit that
	// built it and has not yet read it). So its delete asks the SECTION at WRITE
	// (2) — HEAD's level — on top of the AV read, and its create asks the same
	// (whoever may build the copy of the interview may remove it). The READ_ONLY
	// viewer (section 1, AV 1) is refused BOTH on the section half; READ_COMPONENT
	// (section 2, AV 1) and the TRANSCRIBER (section 2, AV 1) above build and
	// delete their throwaway.
	test("READ_ONLY viewer (section 1, AV 1): the shared WAV's create AND delete are refused ON the section half (required 2)", async () => {
		expect(await getPermissions(ids.level1, AUTHZ_SECTION, AUTHZ_SECTION)).toBe(1);
		expect(await getPermissions(ids.level1, AUTHZ_SECTION, AUTHZ_AV)).toBe(1);
		const answers: Record<string, unknown> = {};
		for (const action of ['create_transcribable_audio_file', 'delete_transcribable_audio_file']) {
			const refusal = await refusalOf(
				handlerOf(action)(contextFor(ids.level1, RECORD_DOORS[action]?.() ?? {})),
			);
			answers[action] = {
				code: refusal.code,
				half: /the section grant/.test(refusal.message),
				required: refusal.coordinates?.required,
			};
		}
		const refused = { code: 'perm.denied', half: true, required: 2 };
		expect(answers).toEqual({
			create_transcribable_audio_file: refused,
			delete_transcribable_audio_file: refused,
		});
	});

	// ── TOOLS-06: the media SOURCE of automatic_transcription is READ-gated ──
	// Every leg above is refused by the transcription_ddo WRITE gate, which runs
	// first — so none of them tells whether the media READ gate exists. These
	// identities pass the write gate on the transcript and fail ONLY on the
	// source: the refusal must name the AV (test94), and nothing past the gates
	// (validation, provider, config, ASR) is reached — a bypassed media gate
	// would surface as a different code, or as a submit.
	test('automatic_transcription: transcript writable (2), the AV at 0 → perm.denied ON test94', async () => {
		const refusal = await refusalOf(
			handlerOf('automatic_transcription')(
				contextFor(ids.textOnly, RECORD_DOORS.automatic_transcription?.() ?? {}),
			),
		);
		expect({ code: refusal.code, tipo: refusal.coordinates?.tipo }).toEqual({
			code: 'perm.denied',
			tipo: AUTHZ_AV,
		});
	});

	test('automatic_transcription: the transcript in scope, ONLY the media record out of scope → perm.out_of_scope ON that record', async () => {
		const options = {
			...(RECORD_DOORS.automatic_transcription?.() ?? {}),
			media_ddo: { ...media(), section_id: outOfScopeRecordId },
		};
		const refusal = await refusalOf(
			handlerOf('automatic_transcription')(contextFor(ids.control, options)),
		);
		expect({ code: refusal.code, section_id: refusal.coordinates?.section_id }).toEqual({
			code: 'perm.out_of_scope',
			section_id: outOfScopeRecordId,
		});
	});

	test('automatic_transcription: the CONTROL passes BOTH gates (whatever it meets next is not a gate)', async () => {
		const outcome = await handlerOf('automatic_transcription')(
			contextFor(ids.control, RECORD_DOORS.automatic_transcription?.() ?? {}),
		).then(
			() => 'served',
			(error: unknown) => (error as { code?: string }).code ?? String(error),
		);
		expect(outcome.startsWith('perm.')).toBe(false);
		expect(outcome).not.toBe('request.invalid');
	});

	// ── the background save re-gate, measured on STORED state ──────────────
	// The poll's save seam re-runs the write door — for the principal resolved
	// NOW and only for a LIVE account — immediately before the transcript is
	// written. The status provider is faked (loopback ASR is SSRF-refused by
	// design). THE REVOCATION HAPPENS INSIDE THE POLL (review r8): the poll starts
	// as the live, granted CONTROL, and the provider itself revokes on its first
	// call — before it answers `status 3` — so only a check at SAVE time can see
	// it. A check moved to the poll's start (or kept at the enqueue) passes and
	// writes: these legs go red. Each refusal leg first proves the target is
	// EMPTY (the save skips a component that already has data, so a non-empty
	// target would make "nothing written" vacuous), then reads the stored
	// component back; the served twin proves the same poll DOES write.
	const answerTranscript = (text: string) => ({
		status: 3,
		transcription_data: { segments: [{ start: 0, end: 1, text }] },
	});
	/** A status provider that runs `revoke` on its FIRST call, then answers `status 3`. */
	const revokingProvider = (text: string, revoke: () => Promise<void>) => {
		let calls = 0;
		return async () => {
			calls++;
			if (calls === 1) await revoke();
			return answerTranscript(text);
		};
	};
	async function runPoll(
		principal: Principal,
		provider: () => Promise<unknown>,
	): Promise<{ saved: number; outcome: string }> {
		const { backgroundTranscriberPoll } = await import(
			'../../tools/tool_transcription/server/index.ts'
		);
		let saved = 0;
		const outcome = await backgroundTranscriberPoll(
			contextFor(principal, {
				key: 'zzauthz-key',
				url: 'http://zzauthz.invalid/api/',
				lang: LANG,
				av_url: '',
				engine: 'babel',
				user_id: principal.userId,
				entity_name: 'zzauthz',
				transcription_ddo: { ...transcript(), section_id: backgroundRecordId },
				pid: 123,
			}),
			{
				statusProvider: provider as never,
				onSaved: () => {
					saved++;
				},
				maxAttempts: 1,
				intervalMs: 0,
			},
		).then(
			() => 'served',
			(error: unknown) => (error as { code?: string }).code ?? String(error),
		);
		return { saved, outcome };
	}
	async function storedTranscript(): Promise<string> {
		const { readMatrixRecord } = await import('../../src/core/db/matrix.ts');
		const { readComponentItems } = await import('../../src/core/resolve/component_data.ts');
		const record = await readMatrixRecord('matrix_test', AUTHZ_SECTION, backgroundRecordId);
		const items = (
			record === null
				? []
				: (readComponentItems(record, AUTHZ_TEXT_AREA, 'component_text_area') ?? [])
		) as {
			value?: unknown;
		}[];
		return items.map((item) => String(item.value ?? '')).join('|');
	}

	test("the background save RE-CHECKS the grant AT SAVE TIME: the CONTROL's grant revoked DURING the poll → NOTHING stored", async () => {
		expect(await storedTranscript()).toBe('');
		// The revocation, through the engine's own save door: the control's account
		// is reassigned to the SECTION_ONLY profile (0 on the transcript) while the
		// provider is still answering — the grant the poll STARTED with is gone.
		const own = authzProfileId(ids.control.userId);
		let revoked = false;
		try {
			const { saved, outcome } = await runPoll(
				ids.control,
				revokingProvider('zzauthz revoked grant', async () => {
					await setUserProfile(ids.control.userId, authzProfileId(AUTHZ_SECTION_ONLY_USER_ID));
					revoked = true;
				}),
			);
			expect({
				revoked,
				saved,
				outcome,
				stored: await storedTranscript(),
			}).toEqual({ revoked: true, saved: 0, outcome: 'tool.action_failed', stored: '' });
		} finally {
			await setUserProfile(ids.control.userId, own);
		}
	});

	test('the background save RE-CHECKS the ACCOUNT AT SAVE TIME: deactivated (dd131 = No) DURING the poll → NOTHING stored, though the profile still grants the pair', async () => {
		expect(await storedTranscript()).toBe('');
		let revoked = false;
		try {
			const { saved, outcome } = await runPoll(
				ids.control,
				revokingProvider('zzauthz deactivated account', async () => {
					await setActiveAccount(ids.control.userId, false);
					revoked = true;
				}),
			);
			expect({
				revoked,
				saved,
				outcome,
				stored: await storedTranscript(),
			}).toEqual({ revoked: true, saved: 0, outcome: 'tool.action_failed', stored: '' });
		} finally {
			await setActiveAccount(ids.control.userId, true);
		}
	});

	// A save FAILURE is not a door refusal (review L3): only perm.* / request.invalid*
	// become the job's quiet terminal sentence; a typed engine error from the save
	// itself (here a db.lock_timeout from saveComponentData) escapes the poll with
	// its own code, as it did before the save asked the door. The door GRANTS here
	// (the live control), the target is empty, and the save is stubbed to throw.
	test('the background save: a typed SAVE failure (db.lock_timeout) ESCAPES the poll with its code — only a door refusal is swallowed', async () => {
		expect(await storedTranscript()).toBe('');
		const REAL_SAVE_COMPONENT = { ...save_component };
		mock.module('../../src/core/section/record/save_component.ts', () => ({
			...REAL_SAVE_COMPONENT,
			saveComponentData: async () => {
				throw new DedaloError('db.lock_timeout');
			},
		}));
		try {
			const { saved, outcome } = await runPoll(ids.control, async () =>
				answerTranscript('zzauthz failing save'),
			);
			expect({ saved, outcome }).toEqual({ saved: 0, outcome: 'db.lock_timeout' });
		} finally {
			mock.module('../../src/core/section/record/save_component.ts', () => REAL_SAVE_COMPONENT);
			mock.restore();
		}
		expect(await storedTranscript()).toBe('');
	});

	test('the background save SERVED twin: the live, granted control (nothing revoked) → the transcript IS stored', async () => {
		expect(await storedTranscript()).toBe('');
		const { saved, outcome } = await runPoll(ids.control, async () =>
			answerTranscript('zzauthz served transcript'),
		);
		expect(saved).toBe(1);
		expect(outcome).toBe('served');
		expect(await storedTranscript()).toContain('zzauthz served transcript');
	});
});

/** dd1725 (the account's profile) through the ENGINE's save door. */
async function setUserProfile(userId: number, profileId: number): Promise<void> {
	const { saveComponentData } = await import('../../src/core/section/record/save_component.ts');
	const saved = await saveComponentData({
		componentTipo: 'dd1725',
		sectionTipo: 'dd128',
		sectionId: userId,
		lang: 'lg-nolan',
		changedData: [
			{
				action: 'set_data',
				key: null,
				value: [
					{
						type: 'dd151',
						section_id: profileId,
						section_tipo: 'dd234',
						from_component_tipo: 'dd1725',
					},
				],
			} as never,
		],
		userId: -1,
	});
	if (!saved.ok)
		throw new Error(`setUserProfile(${userId}, ${profileId}) failed: ${JSON.stringify(saved)}`);
}

/** dd131 'Active account' through the ENGINE's save door (dd64/1 = Yes, dd64/2 = No). */
async function setActiveAccount(userId: number, active: boolean): Promise<void> {
	const { saveComponentData } = await import('../../src/core/section/record/save_component.ts');
	const saved = await saveComponentData({
		componentTipo: 'dd131',
		sectionTipo: 'dd128',
		sectionId: userId,
		lang: 'lg-nolan',
		changedData: [
			{
				action: 'set_data',
				key: null,
				value: [
					{
						type: 'dd151',
						section_id: active ? 1 : 2,
						section_tipo: 'dd64',
						from_component_tipo: 'dd131',
					},
				],
			} as never,
		],
		userId: -1,
	});
	if (!saved.ok)
		throw new Error(`setActiveAccount(${userId}, ${active}) failed: ${JSON.stringify(saved)}`);
}
