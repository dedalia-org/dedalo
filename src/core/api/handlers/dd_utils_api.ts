/**
 * dd_utils_api handlers (WS-C S2-25 extraction — bodies moved VERBATIM from
 * api/dispatch.ts; dispatch keeps registry assembly + gates + envelope).
 */

import { config } from '../../../config/config.ts';
import { readString } from '../../../config/readers.ts';
import { isValidTipo } from '../../concepts/ontology.ts';
import { DedaloError, isDedaloError, ok } from '../../errors/index.ts';
import { publicOrigin, publicOriginIsLocal } from '../../resolve/public_origin.ts';
import { login } from '../../security/auth.ts';
import { getPermissions } from '../../security/permissions.ts';
import { isLoopbackHost } from '../../security/ssrf_guard.ts';
import { DEDALO_DATA_VERSION, parseVersionString } from '../../update/version.ts';
import { type ActionHandler, requirePrincipal } from '../handler_context.ts';
import type { ApiResult } from '../response.ts';

/**
 * Human-readable SQL for the SQO dev console: substitute $N placeholders with
 * their param values. Iterate high→low so $1 never matches inside $10 (SEC:
 * display only — the executed query always uses the bound params, never this
 * string).
 */
export function resolveSqlForDisplay(sql: string, params: readonly unknown[]): string {
	let resolved = sql;
	for (let i = params.length; i >= 1; i--) {
		const param = params[i - 1];
		const literal =
			typeof param === 'number' ? String(param) : `'${String(param).replace(/'/g, "''")}'`;
		resolved = resolved.replaceAll(`$${i}`, literal);
	}
	return resolved;
}

/**
 * A manifest built on a LOCAL public origin (DEDALO_HOST unset or loopback) lists
 * `http://localhost/...` urls: correct for a caller on this same machine, useless to
 * any other — whose origin check then refuses every file with an "origin mismatch"
 * that names the wrong machine. Refuse at the master instead, naming the key to fix.
 * Runs AFTER authorizeUpdateManifest, so only an authorized peer learns of it.
 * `clientIp` 'local' = the unix socket with no forwarded address (same machine).
 */
export function localOriginRefusal(input: {
	originIsLocal: boolean;
	clientIp: string;
}): string | null {
	if (!input.originIsLocal) return null;
	if (input.clientIp === 'local' || isLoopbackHost(input.clientIp)) return null;
	return 'Error. This update server advertises a local origin (DEDALO_HOST is unset or loopback); its download URLs are unreachable from other machines. Set DEDALO_HOST (and DEDALO_PROTOCOL) on the server.';
}

/**
 * The shared authorization gate of the TWO update manifest doors
 * (get_ontology_update_info + get_code_update_info). Both doors ask the same
 * three questions in the same order, but NOT with the same answers — the
 * asymmetry is the point of having one function:
 *
 * - `allowLocalhost`: the ontology door honors the 'localhost' pseudo-code
 *   (the panel's 'Local files' source posts it to our own API); the code door
 *   does not.
 * - `requiredParts`: the ontology door reads TWO parts (the IO dir is
 *   major.minor); the code door demands a full THREE-part triple.
 * - `serverKind`: only the refusal bytes differ ('an code server' is a PHP
 *   parity typo — correcting it is a wire change, not a cleanup).
 *
 * ORDER IS SECURITY: an install that is not a master answers 'not a … server'
 * BEFORE any code is examined, so a wrong code can never confirm that this
 * host is a master.
 */
export function authorizeUpdateManifest(input: {
	isServer: boolean;
	configuredCodes: readonly (string | undefined)[];
	allowLocalhost: boolean;
	presentedCode: unknown;
	versionRaw: unknown;
	requiredParts: 2 | 3;
	/** Refusal wording of the first gate. Default 'ontology' (PHP parity bytes). */
	serverKind?: 'ontology' | 'code';
}): { ok: true; version: number[] } | { ok: false; msg: string } {
	if (input.isServer !== true) {
		return input.serverKind === 'code'
			? // PHP parity: the 'an code' typo is the wire byte, do not correct it.
				{ ok: false, msg: 'Error. Server is not an code server' }
			: { ok: false, msg: 'Error. Server is not an ontology server' };
	}
	const versionRaw = typeof input.versionRaw === 'string' ? input.versionRaw : '';
	// Two parts: split on dots and read major/minor positionally (Number('') is
	// 0, so a bare '' fails only on the MISSING minor — keep both checks).
	// Three parts: the shared parseVersionString (strips a '.dev' tail).
	const version =
		input.requiredParts === 2
			? [Number(versionRaw.split('.')[0]), Number(versionRaw.split('.')[1])]
			: parseVersionString(versionRaw);
	if (version.length < input.requiredParts || version.some((n) => !Number.isInteger(n))) {
		return { ok: false, msg: 'Error. Invalid version number' };
	}
	const codes = new Set(
		input.configuredCodes.filter((code): code is string => typeof code === 'string' && code !== ''),
	);
	if (input.allowLocalhost) {
		codes.add('localhost');
	}
	if (typeof input.presentedCode !== 'string' || !codes.has(input.presentedCode)) {
		return { ok: false, msg: 'Error. Invalid code' };
	}
	return { ok: true, version };
}

/**
 * The login answer's token keys: the fresh session's `csrf_token` and, beside
 * it, its owner `session_user_id` (WC-2026-10-11-session-user-beside-csrf-token)
 * — both absent when the session cannot be read back. Split out of `login` so
 * the pairing is one decision, not two that could disagree.
 */
function tokenWithOwner(
	session: { csrfToken: string } | null | undefined,
	userId: number | undefined,
): { csrf_token?: string; session_user_id?: number } {
	return session ? { csrf_token: session.csrfToken, session_user_id: userId } : {};
}

/**
 * The {section_tipo, section_id} a record-scoped read names, or null when the
 * request does not name one.
 *
 * Split out of `get_record_jobs` to keep that handler under the complexity cap:
 * validation is its own concern, and INT is the canonical section_id form
 * (WC-2026-08-10-section-id-int-canonical) — the client may send either
 * spelling, and this is the boundary that settles it.
 */
function parseRecordRef(options: unknown): { sectionTipo: string; sectionId: number } | null {
	const source = (options ?? {}) as { section_tipo?: unknown; section_id?: unknown };
	const sectionTipo = typeof source.section_tipo === 'string' ? source.section_tipo : '';
	const sectionId = Number(source.section_id);
	if (sectionTipo === '') return null;
	if (!Number.isInteger(sectionId) || sectionId <= 0) return null;
	return { sectionTipo, sectionId };
}

/**
 * The ONE lock action that needs no section read gate
 * (WC-2026-10-23-own-lock-cleanup-ungated).
 *
 * The read gate exists so a user cannot fabricate lock state on records they
 * cannot see: `focus` ACQUIRES a lock other users then run into, `blur` names
 * a record. `delete_user_section_locks` (section/locks.ts) only DELETEs rows
 * `WHERE section_tipo = $1 AND user_id = <the principal>` — the caller's own
 * locks — plus the global expired-row GC, which is not section-scoped (any
 * readable section's navigation already ran it) and removes only locks every
 * reader already treats as released. It creates nothing and cannot touch
 * another user's live lock, so gating it protects nobody — and it refused a
 * surface that holds no lock at all: a non-admin paginating the inspector
 * "Latest changes" list (an embedded dd15 section; a bare dd15 read is
 * admin-only) got a 403 (the client no longer sends it from a read-only Time
 * Machine list — section.js navigate — this is the server half).
 */
const OWN_LOCK_CLEANUP_ACTION = 'delete_user_section_locks';

/**
 * The ONE validation of a lock handler's `options.section_tipo`, run before any
 * branch reads it. Absent / null / '' → request.invalid_options (the field is
 * required); present but not a STRING in the tipo grammar → request.invalid_tipo.
 * A truthiness check is not a type check: before this, an array, object, number
 * or free string went straight into getPermissions and — for the ungated
 * OWN_LOCK_CLEANUP_ACTION — straight into the DELETE's bind.
 *
 * Gate: test/unit/lock_section_tipo_grammar_native.test.ts.
 */
function requireLockSectionTipo(value: unknown, action: string): string {
	if (value === undefined || value === null || value === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'options.section_tipo is required',
			message: `${action}: section_tipo is required`,
		});
	}
	if (typeof value !== 'string' || !isValidTipo(value)) {
		throw new DedaloError('request.invalid_tipo', {
			message: `${action}: options.section_tipo is not a valid tipo: ${JSON.stringify(value)?.slice(0, 80)}`,
			coordinates: { where: `${action}.section_tipo` },
		});
	}
	return value;
}

/** dd_utils_api action handlers, keyed by action (registered in dispatch.ts). */
/** The staged file's preview thumbnail after a chunked join (null when nothing was staged). */
async function joinedThumbnailUrl(
	userId: number,
	keyDir: string,
	joined: { tmpName?: string; extension?: string },
): Promise<string | null> {
	if (!joined.tmpName) return null;
	const { createStagedThumbnail } = await import('../../media/ingest/staged_thumbnail.ts');
	return createStagedThumbnail(userId, keyDir, joined.tmpName, joined.extension ?? null);
}

export const utilsApiActions: Record<string, ActionHandler> = {
	update_lock_components_state: async (rqo, context) => {
		// Component soft-lock events (PHP dd_utils_api). Read permission on
		// the section is required to participate in its lock state (prevents
		// fabricating focus/blur on records the user cannot see) — for every
		// action EXCEPT the caller's own cleanup, see OWN_LOCK_CLEANUP_ACTION.
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as {
			section_id?: unknown;
			section_tipo?: unknown;
			component_tipo?: string | null;
			action?: string;
		};
		// Fail-closed (L4): section_tipo is required AND a tipo — validated before
		// any branch, so the ungated own-lock cleanup binds a tipo too — and the
		// read gate runs for every action but that cleanup; an unknown action is
		// gated like focus.
		const sectionTipo = requireLockSectionTipo(
			options.section_tipo,
			'update_lock_components_state',
		);
		if (options.action !== OWN_LOCK_CLEANUP_ACTION) {
			const level = await getPermissions(principal, sectionTipo, sectionTipo);
			if (level < 1) {
				throw new DedaloError('perm.denied', {
					coordinates: { section_tipo: sectionTipo },
				});
			}
		}
		const { updateLockComponentsState } = await import('../../section/locks.ts');
		const outcome = await updateLockComponentsState({
			section_id: options.section_id ?? null,
			section_tipo: sectionTipo,
			component_tipo: options.component_tipo ?? null,
			action: options.action ?? '',
			user_id: principal.userId,
			full_username: principal.userId < 0 ? 'Debug user' : (context.session?.username ?? ''),
		});
		// The lock answer is a PAYLOAD, not an envelope (section/locks.ts): the
		// applied flag is the envelope `data`, and the keys the client reads by
		// name (`in_use`, `full_username`, `msg`, plus the PHP `dato` /
		// `dedalo_notification` fossils) ride as extension keys — ERRORS_SPEC §3.0.
		const { applied, ...lockFields } = outcome;
		return {
			status: 200,
			body: ok(applied, {
				requestId: context.requestId,
				extend: { ...lockFields, dedalo_notification: null },
			}),
		};
	},
	get_lock_status: async (rqo, context) => {
		// Read-only poll: is the component held by another user? (PHP parity.)
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as {
			section_id?: unknown;
			section_tipo?: unknown;
			component_tipo?: string | null;
		};
		// Fail-closed (L4): section_tipo is required AND a tipo, and the read gate
		// runs unconditionally — never skip it when the field is absent/falsy.
		const sectionTipo = requireLockSectionTipo(options.section_tipo, 'get_lock_status');
		{
			const level = await getPermissions(principal, sectionTipo, sectionTipo);
			if (level < 1) {
				throw new DedaloError('perm.denied', {
					coordinates: { section_tipo: sectionTipo },
				});
			}
		}
		const { getLockStatus } = await import('../../section/locks.ts');
		const outcome = await getLockStatus({
			section_id: options.section_id ?? null,
			section_tipo: sectionTipo,
			component_tipo: options.component_tipo ?? null,
			user_id: principal.userId,
		});
		// `in_use` / `full_username` are the keys the client's release poll reads;
		// `data` carries the boolean the PHP body spelled `result` (page.js checks
		// `in_use`, but the compat mirror must stay a truthy answer, not null).
		return {
			status: 200,
			body: ok(true, { requestId: context.requestId, extend: { ...outcome } }),
		};
	},
	get_dedalo_files: async (_rqo, context) => {
		// The service-worker pre-cache manifest (PHP dd_utils_api::
		// get_dedalo_files). Authenticated read — the auth gate already ran
		// (not in NO_LOGIN_ACTIONS, matching PHP); CSRF-exempt like PHP (the
		// SW calls without the page's token). `data` is the manifest;
		// `dedalo_version` (the SW cache key) rides as an extension key —
		// service_worker.js / worker_cache.js read `response_data()` + `dedalo_version`.
		const { buildDedaloFilesResponse } = await import('../dedalo_files.ts');
		const manifest = buildDedaloFilesResponse();
		return {
			status: 200,
			body: ok(manifest.result, {
				requestId: context.requestId,
				extend: { dedalo_version: manifest.dedalo_version },
			}),
		};
	},
	get_job_events: async (rqo, context) => {
		// The NATIVE job status wire (core/api/job_stream.ts): the caller subscribes
		// to an in-process job by `job_id` and every state change is PUSHED as it
		// happens — no {pid, pfile} handle, no re-reading a file on a timer. The
		// stream ends on the terminal frame, whose `data` is the job's return value
		// (for an import, the full report). get_process_status below is the legacy
		// poll wire, kept for the AV transcode + backup consumers.
		const principal = requirePrincipal(context);
		const { getJobEvents } = await import('../job_stream.ts');
		return getJobEvents(rqo, principal);
	},
	get_process_status: async (rqo, context) => {
		// Background-process status SSE stream (PHP dd_utils_api::
		// get_process_status; audit S2-15/DEC-22a + S2-35): the copied client's
		// update_process_status polls media transcode / backup pfiles through
		// this. Session-gated; the pfile is reduced to a job-id basename inside
		// the processes dir (see core/api/process_status.ts).
		const principal = requirePrincipal(context);
		const { getUtilsProcessStatus } = await import('../process_status.ts');
		// The principal authorizes the poll: a job that carries user data (a tool's
		// background run) streams only to its owner — the ids are guessable.
		return getUtilsProcessStatus(rqo, principal);
	},
	get_record_jobs: async (rqo, context) => {
		// "What is running for THIS record?" — the question no surface could ask
		// before, which is why an upload's background transcode was invisible and an
		// empty tier cell was indistinguishable from "never built".
		//
		// AUTHORIZED BY THE RECORD, NOT BY JOB OWNERSHIP, and deliberately so: a
		// second operator looking at the same record must see that a tier is already
		// being built, or they start a duplicate encode over the same output path.
		// The payload is therefore reduced to OPERATIONAL SHAPE — never the job's
		// `data`, which stays owner-only behind the untouched mayStreamJob (see
		// job_stream.ts). jobs.ts already draws this exact line for unowned jobs.
		const principal = requirePrincipal(context);
		const ref = parseRecordRef(rqo.options);
		if (ref === null) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'options.section_tipo and an integer options.section_id are required',
			});
		}
		const { sectionTipo, sectionId } = ref;
		const level = await getPermissions(principal, sectionTipo, sectionTipo);
		if (level < 1) {
			throw new DedaloError('perm.denied', { coordinates: { section_tipo: sectionTipo } });
		}
		const { mediaJobs } = await import('../../media/jobs.ts');
		const { activityRowFromMediaJob, stampForeignOwnerNames } = await import('../activity.ts');
		const records = mediaJobs.jobsForRecord(sectionTipo, sectionId);
		const rows = records.map(activityRowFromMediaJob);
		await stampForeignOwnerNames(records, rows, principal.userId);
		// `jobs` is the owned top-level key the activity tray reads by name.
		return {
			status: 200,
			body: ok(true, { requestId: context.requestId, extend: { jobs: rows } }),
		};
	},
	get_record_info: async (rqo, context) => {
		// The inspector's Information panel: created / modified / published.
		// Its OWN request, fetched after the section renders, so the section read
		// never pays for it (core/section/record/record_info.ts). Authorized by
		// the section grant AND the record's project scope — the same record a
		// read would refuse is refused here.
		const principal = requirePrincipal(context);
		const ref = parseRecordRef(rqo.options);
		if (ref === null) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'options.section_tipo and an integer options.section_id are required',
			});
		}
		const { sectionTipo, sectionId } = ref;
		const level = await getPermissions(principal, sectionTipo, sectionTipo);
		const { principalCanAccessRecord } = await import('../../security/record_scope.ts');
		if (level < 1 || !(await principalCanAccessRecord(sectionTipo, sectionId, principal))) {
			throw new DedaloError('perm.denied', {
				coordinates: { section_tipo: sectionTipo, section_id: sectionId },
			});
		}
		const { getRecordInfo } = await import('../../section/record/record_info.ts');
		const { resolveUserName } = await import('../../security/user_identity.ts');
		const { currentApplicationLang } = await import('../../resolve/request_lang.ts');
		const lang = currentApplicationLang();
		// The audit stamps are component values: each passes the standing
		// metadata grant (searchSurfaceGrants — the rule that offers them to every
		// searcher) or the caller's own component grant.
		const { ddoIsAuthorized, searchSurfaceGrants } = await import('../../security/permissions.ts');
		const recordInfo = await getRecordInfo(sectionTipo, sectionId, {
			resolveName: (userId) => resolveUserName(userId, lang),
			canReadAudit: async (tipo) =>
				searchSurfaceGrants(sectionTipo, tipo) ||
				(await ddoIsAuthorized(principal, sectionTipo, tipo)),
		});
		// `record_info` is the owned top-level key the inspector reads by name;
		// null = no such record (a deleted / never-saved id).
		return {
			status: 200,
			body: ok(true, { requestId: context.requestId, extend: { record_info: recordInfo } }),
		};
	},
	get_activity: async (_rqo, context) => {
		// The activity tray's read model — the caller's OWN work across BOTH job
		// systems (core/api/activity.ts explains why aggregating is the point).
		const principal = requirePrincipal(context);
		const { collectActivity } = await import('../activity.ts');
		return {
			status: 200,
			body: ok(true, {
				requestId: context.requestId,
				extend: { jobs: await collectActivity(principal.userId) },
			}),
		};
	},
	stop_process: async (rqo, context) => {
		// Stop a background job (PHP dd_utils_api::stop_process): the generic Stop
		// button's wire. Session-gated + owner-gated; aborts the job's controller
		// so the handler winds down cooperatively (core/api/process_status.ts).
		const principal = requirePrincipal(context);
		const { stopUtilsProcess } = await import('../process_status.ts');
		return stopUtilsProcess(rqo, principal, context.requestId);
	},
	get_system_info: async (_rqo, context) => {
		// Upload/import/media-edit init call (PHP dd_utils_api::get_system_info).
		// Authenticated read (the router's session+CSRF gate already ran); returns
		// the upload-limit negotiation payload the client reads before transfer.
		const { buildSystemInfo } = await import('./system_info.ts');
		return { status: 200, body: ok(buildSystemInfo(), { requestId: context.requestId }) };
	},
	join_chunked_files_uploaded: async (rqo, context) => {
		// Assemble a chunked upload (PHP dd_utils_api::join_chunked_files_uploaded).
		// The client posts every chunk to the multipart upload endpoint, then —
		// once its own counter (chunk_index/total_chunks) shows all arrived —
		// fires this JSON RQO to join them + re-sniff (SEC-066). Fail-closed:
		// anonymous → 404. State-changing: the router already enforced CSRF.
		if (context.session === null) {
			// Fail-closed: the same 404 shape a route miss answers (no existence leak).
			throw new DedaloError('resource.not_found');
		}
		const options = (rqo.options ?? {}) as {
			file_data?: {
				key_dir?: unknown;
				tmp_name?: unknown;
				total_chunks?: unknown;
				// The transfer identity the chunk responses echoed; the client
				// forwards file_data verbatim, so it arrives here untouched.
				upload_id?: unknown;
			};
			files_chunked?: unknown[];
		};
		const fileData = options.file_data ?? {};
		// ONE coercion of the staging key: the join, the thumbnail and the failure
		// coordinates all address the same directory.
		const keyDir = String(fileData.key_dir ?? '');
		const filesChunked = Array.isArray(options.files_chunked) ? options.files_chunked : [];
		// total_chunks: the dense files_chunked array length, or the echoed count.
		const totalChunks =
			filesChunked.length > 0 ? filesChunked.length : Number(fileData.total_chunks ?? 0);
		try {
			const { joinChunkedUpload } = await import('../../media/ingest/upload.ts');
			// Awaited: the assembly is O(file size) and yields between windows so a
			// multi-GB join does not freeze every other request (S-7).
			const joined = await joinChunkedUpload({
				keyDir,
				tmpName: String(fileData.tmp_name ?? ''),
				totalChunks,
				userId: context.session.userId,
				// Untrusted: the receiver validates it against UPLOAD_ID_PATTERN and
				// REFUSES a malformed one rather than sanitizing it. Absent (a client
				// that does not echo it back yet) the join falls back to matching the
				// server-recorded proposal + part count, and refuses when several match.
				uploadId: typeof fileData.upload_id === 'string' ? fileData.upload_id : null,
			});
			// The preview thumbnail, exactly as the single-shot path builds it
			// (upload_endpoint.ts). BOTH completion paths must emit it or they are
			// not the same wire: `receiveUpload` reports `complete:false` for every
			// chunk, so a chunked transfer's ONLY completion moment is right here.
			//
			// (!) This was the regression that proved the plan's named risk real.
			// service_dropzone never chunked — it posted every file whole — so the
			// single-shot branch was the only one the ingest path ever reached and
			// the join never needed a thumbnail. The moment the import tools moved
			// onto the chunking transport, every file over
			// DEDALO_UPLOAD_SERVICE_CHUNK_FILES MB completed through the join and
			// silently lost its preview. It shows up worst on exactly the formats
			// the thumbnail exists FOR: a browser cannot render a TIFF, so the
			// client's `thumbnail_url || url` fallback has nothing to draw and the
			// row renders blank.
			//
			// Best effort, like the single-shot path: a thumbnail failure must
			// never fail an upload whose bytes are already staged and verified.
			const thumbnailUrl = await joinedThumbnailUrl(context.session.userId, keyDir, joined);
			return {
				status: 200,
				body: ok(true, {
					requestId: context.requestId,
					extend: {
						file_data: {
							key_dir: fileData.key_dir ?? null,
							tmp_name: joined.tmpName ?? null,
							// THE HUMAN FILE NAME (PHP file_data->name — the join MUTATES the
							// client's file_data, so `name` survived it there). Taken from the
							// SERVER's per-transfer meta, not from the relayed request.
							//
							// This key is for the CLIENT (the queue row's label, and the PHP
							// wire shape). It is NOT how the archive gets the name: the ingest
							// runs in a later request and reads the name the receiver persisted
							// beside the staged file (media/ingest/staged_name_record.ts),
							// precisely so a caller that does not relay this key still records
							// 'María Piñón.jpg' rather than 'Mar_a_Pi_n.jpg'.
							name: joined.name ?? null,
							extension: joined.extension ?? null,
							chunked: false,
							complete: true,
							// null when the format is not rasterisable — the client keeps
							// its own local preview in that case and must not blank the img.
							thumbnail_url: thumbnailUrl,
						},
					},
				}),
			};
		} catch (error) {
			// Keep the join's own diagnosis (upload_conflict is retryable, too_large and
			// upload_rejected say the bytes are quarantined); wrapping hid all of them.
			if (error instanceof DedaloError) throw error;
			throw new DedaloError('media.action_failed', {
				cause: error,
				message: 'join_chunked_files_uploaded: join failed',
				coordinates: { key_dir: keyDir, total_chunks: totalChunks },
			});
		}
	},
	change_lang: async (rqo, context) => {
		// Persist the user's interface/data language choice (PHP dd_utils_api::
		// change_lang → $_SESSION['dedalo']['config']). The client's two menu
		// selectors both post here, then full-reload; every subsequent request
		// rebuilds with the stored language (see core/resolve/request_lang.ts).
		// State-changing: the router ran the CSRF gate for authenticated callers.
		// A session is NOT guaranteed — the LOGIN PANEL's selector posts here too
		// (change_lang is in NO_LOGIN_ACTIONS). With a session the choice is stored
		// on the session row; without one it goes to the anonymous language cookie,
		// which dispatch reads back when seeding the request language scope.
		const options = (rqo.options ?? {}) as {
			dedalo_application_lang?: unknown;
			dedalo_data_lang?: unknown;
		};
		const { isValidLang } = await import('../../concepts/ontology.ts');
		// Validate against the identifier allowlist BEFORE storing — the value
		// later flows into JSONB paths through the identifier gate (SEC §7.6),
		// so an invalid tag must never be persisted.
		const readLang = (raw: unknown): string | undefined => {
			if (typeof raw !== 'string' || raw === '') return undefined;
			const trimmed = raw.trim();
			return isValidLang(trimmed) ? trimmed : undefined;
		};
		let applicationLang = readLang(options.dedalo_application_lang);
		let dataLang = readLang(options.dedalo_data_lang);
		// DEDALO_DATA_LANG_SYNC (PHP change_lang): when the install couples the
		// two languages, a change to either drives the other. Off on this
		// install (page_globals.dedalo_data_lang_sync=false); replicated for parity.
		if (config.menu.dataLangSync === true) {
			if (applicationLang !== undefined) dataLang = applicationLang;
			else if (dataLang !== undefined) applicationLang = dataLang;
		}
		if (applicationLang === undefined && dataLang === undefined) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'No valid language supplied',
			});
		}
		const result: ApiResult = {
			status: 200,
			body: ok(true, { requestId: context.requestId }),
		};
		if (context.session !== null && context.sessionToken) {
			const { setSessionLangs } = await import('../../security/session_store.ts');
			setSessionLangs(context.sessionToken, { applicationLang, dataLang });
		} else if (applicationLang === undefined) {
			// Anonymous, data language only: there is nowhere to put it. The cookie
			// carries the APPLICATION language alone (the data-lang selector is an
			// authenticated affordance), so storing nothing while answering ok(true)
			// would be a silent no-op — refuse loudly instead.
			// The CODE is the accurate one — the refusal really is "no session" — and
			// the client's relogin policy is safe on it (error_dispatch relogin()
			// returns recovered:false when page_globals.is_logged !== true, which is
			// exactly the login page). No publicMessage: `auth.not_logged` is
			// disclosure:'operator', so one would be discarded by the converter.
			throw new DedaloError('auth.not_logged', {
				message: 'change_lang: the data language has no pre-auth store (cookie is app-lang only)',
			});
		}
		if (applicationLang !== undefined) {
			// THE COOKIE MIRRORS THE APPLICATION LANGUAGE ALWAYS, authenticated or not
			// — not only on the anonymous branch. It is the store that OUTLIVES the
			// session, and `login` adopts it, so a cookie left behind by the login form
			// would otherwise reinstate itself over every later in-app choice: pick
			// Català once on the form, set Deutsch in the menu, log out, and the next
			// login would come back Catalan forever, with no affordance to undo it.
			// Refreshing here keeps the two stores from disagreeing by construction.
			result.setPreauthLangCookie = applicationLang;
		}
		const changed = [
			applicationLang !== undefined ? `dedalo_application_lang to ${applicationLang}` : null,
			dataLang !== undefined ? `dedalo_data_lang to ${dataLang}` : null,
		].filter(Boolean);
		console.info(`[change_lang] changed ${changed.join(', ')}`);
		return result;
	},
	get_login_context: async (_rqo, context) => {
		// The login form's own context request (PHP dd_utils_api::
		// get_login_context) — pre-auth by design (the form must render
		// before any session exists). Returns [login context].
		const { buildLoginContext } = await import('./login_context.ts');
		return { status: 200, body: ok([await buildLoginContext()], { requestId: context.requestId }) };
	},
	list_uploaded_files: async (rqo, context) => {
		// The upload service's multi-file queue lists the user's already-staged files (PHP
		// dd_utils_api::list_uploaded_files → scandir(DEDALO_UPLOAD_TMP_DIR/user))
		// on EVERY render and injects them as existing rows. That is the mechanism
		// by which a pending upload queue survives a page reload.
		//
		// This used to return a hardcoded `[]` with "full temp-dir scan is uncovered
		// scope" — a silent narrowing that read as "nothing staged" and was the
		// direct cause of "temporal data is not preserved across reload":
		// tool_import_files came back from a reload with an empty queue even
		// though the files were still on disk.
		//
		// Keeping the response a 200 with an ARRAY result still matters for the
		// reason the old stub noted: an error here accumulates into
		// page_globals.api_errors, which makes the NEXT element's render bail
		// before setting status='rendered' (common.js:404).
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as { key_dir?: unknown };
		const keyDir = typeof options.key_dir === 'string' ? options.key_dir : '';
		if (keyDir === '') {
			return { status: 200, body: ok([], { requestId: context.requestId }) };
		}
		const { listStagedFiles } = await import('../../media/ingest/staged_files.ts');
		try {
			return {
				status: 200,
				body: ok(listStagedFiles(principal.userId, keyDir), { requestId: context.requestId }),
			};
		} catch (error) {
			// A malformed key_dir (or an unreadable staging root) must not poison
			// page_globals.api_errors and break the sibling renders — log it and
			// answer with the empty-but-well-shaped array.
			console.error('[list_uploaded_files] staging scan failed:', (error as Error).message);
			return { status: 200, body: ok([], { requestId: context.requestId }) };
		}
	},
	delete_uploaded_file: async (rqo, context) => {
		// The queue renderer's row-removal path fires this for any file that
		// reached the server (found in the since-deleted
		// render_edit_service_dropzone.js:874 — provenance, not a live path).
		// It was never
		// implemented, so every removal 400'd: the row vanished from the UI while
		// the bytes stayed in the staging dir forever — and the accumulated
		// api_errors broke sibling renders.
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as {
			key_dir?: unknown;
			file_name?: unknown;
			// OPTIONAL explicit cancel (WC-2026-08-03-chunked-upload-identity): a row
			// removed before its transfer completed has no staged file to delete, only
			// parts under `.up_<upload_id>/`. With it they go now; without it the age
			// sweep collects them (src/core/media/ingest/staging_gc.ts).
			//
			// It is ALSO the release for a QUARANTINED transfer — one whose assembled
			// bytes failed content verification and were kept rather than destroyed
			// (ingest/upload.ts quarantineAssembled). Same directory, same cancel.
			upload_id?: unknown;
		};
		const keyDir = typeof options.key_dir === 'string' ? options.key_dir : '';
		const fileName = typeof options.file_name === 'string' ? options.file_name : '';
		const uploadId = typeof options.upload_id === 'string' ? options.upload_id : null;
		if (keyDir === '' || fileName === '') {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'options.key_dir and options.file_name are required',
			});
		}
		const { deleteStagedFile } = await import('../../media/ingest/staged_files.ts');
		try {
			// Deleting an already-absent file is a successful no-op: the client has
			// already removed the row, and a retry/double-fire must not surface an
			// error the user cannot act on.
			deleteStagedFile(principal.userId, keyDir, fileName, undefined, uploadId);
			return { status: 200, body: ok(true, { requestId: context.requestId }) };
		} catch (error) {
			// A rejected segment (traversal attempt / malformed name) is the only
			// way here — report it without leaking the resolved path (the resolver's
			// own message rides `cause`, which is never serialized).
			throw new DedaloError('request.invalid_options', {
				cause: error,
				publicMessage: 'Invalid file reference',
			});
		}
	},
	login: async (rqo, context) => {
		const options = (rqo.options ?? {}) as { username?: string; auth?: string };
		const outcome = await login(
			String(options.username ?? ''),
			String(options.auth ?? ''),
			context.clientIp,
		);
		if (!outcome.ok) {
			// The AMBIGUOUS refusal: `auth.login_failed`'s registry message IS
			// LOGIN_FAILED_MESSAGE, and its disclosure is `operator`, so no call site
			// can narrow it into an account-existence oracle.
			throw new DedaloError('auth.login_failed', { coordinates: { client_ip: context.clientIp } });
		}
		// The fresh session's CSRF token must ship with the login response —
		// every subsequent non-exempt action requires it (PHP appends the
		// token to all responses; the session here is created mid-handler,
		// so the dispatch-level append cannot see it).
		const { getSession } = await import('../../security/session_store.ts');
		const freshSession = getSession(outcome.sessionToken as string);
		// Carry the language chosen on the LOGIN PANEL into the new session, so the
		// app opens in the language the form was just switched to instead of the
		// install default. Through allowlistedPreauthLang — the ONE door the cookie
		// enters by — because it is caller-controlled input.
		const { allowlistedPreauthLang } = await import('../../resolve/request_lang.ts');
		const adoptedLang = allowlistedPreauthLang(context.preauthLang);
		if (adoptedLang !== null) {
			const { setSessionLangs } = await import('../../security/session_store.ts');
			// DEDALO_DATA_LANG_SYNC: setSessionLangs is two independent UPDATEs and
			// applies no coupling of its own, so the sync rule is re-applied here.
			// Without it adoption could mint a session state change_lang itself can
			// never produce (application_lang moved, data_lang left at the default).
			setSessionLangs(outcome.sessionToken as string, {
				applicationLang: adoptedLang,
				...(config.menu.dataLangSync === true ? { dataLang: adoptedLang } : {}),
			});
		}
		return {
			status: 200,
			// `user_id` + `csrf_token` are owned top-level keys: the fresh session is
			// created mid-handler, so the dispatch-level csrf_token append cannot see it.
			// `session_user_id` travels with the token, as on every other response
			// (dispatch.ts executeRqo, WC-2026-10-11-session-user-beside-csrf-token): the
			// client adopts a token only for its own page user.
			body: ok(true, {
				requestId: context.requestId,
				extend: { user_id: outcome.userId, ...tokenWithOwner(freshSession, outcome.userId) },
			}),
			setSessionToken: outcome.sessionToken,
			// Media access control (Rule A). Undefined when the mode is false, so a
			// protection-off install emits exactly ONE Set-Cookie, as before.
			setMediaAuthCookie: outcome.mediaAuthCookieValue,
		};
	},
	request_password_reset: async (rqo, context) => {
		// Forgot-password step 1 (pre-auth by design — NO_LOGIN + CSRF-exempt in
		// dispatch.ts, PHP dd_manager whitelist parity). Anti-enumeration and
		// throttling live in security/password_reset.ts; the response is always
		// the same generic shape.
		const options = (rqo.options ?? {}) as { identifier?: unknown };
		const { requestPasswordReset } = await import('../../security/password_reset.ts');
		const outcome = await requestPasswordReset(String(options.identifier ?? ''), context.clientIp);
		// `reset_id` + `msg` are top-level keys render_login.js reads by name; the
		// envelope `data` is the boolean the PHP body spelled `result: true`.
		return {
			status: 200,
			body: ok(true, { requestId: context.requestId, extend: { ...outcome } }),
		};
	},
	confirm_password_reset: async (rqo, context) => {
		// Forgot-password step 2 (pre-auth by design, see request_password_reset).
		const options = (rqo.options ?? {}) as {
			reset_id?: unknown;
			code?: unknown;
			new_password?: unknown;
		};
		const { confirmPasswordReset } = await import('../../security/password_reset.ts');
		// Every refusal THROWS a registered password_reset.* code; the dispatch
		// catch converts it (status from the registry).
		const outcome = await confirmPasswordReset(
			String(options.reset_id ?? ''),
			String(options.code ?? ''),
			String(options.new_password ?? ''),
			context.clientIp,
		);
		// `data: true` — render_login.js gates the success branch on
		// `response_data(api_response)===true`.
		return {
			status: 200,
			body: ok(true, { requestId: context.requestId, extend: { ...outcome } }),
		};
	},
	quit: async (_rqo, context) => {
		// Log out (PHP dd_utils_api::quit → session teardown). The client's
		// menu quit button posts here; on result===true it purges its local
		// caches/service-worker and redirects (login.js quit()). Authenticated
		// + state-changing: the router already ran auth + CSRF gates, so the
		// session and its token are guaranteed here.
		// Activity audit (PHP logger 'LOG OUT' code 2, login::Quit) — logged
		// BEFORE the session is destroyed, while the actor is still known.
		{
			const { logActivity, hostFromClientIp } = await import('./activity_log.ts');
			const { LOGIN_ACTIVITY_TIPO } = await import('../../security/auth.ts');
			const session = context.session;
			await logActivity({
				what: 'LOG OUT',
				tipo: LOGIN_ACTIVITY_TIPO,
				userId: session?.userId ?? 0,
				host: hostFromClientIp(context.clientIp),
				data: {
					msg: `User ${session?.userId ?? ''} was logout. Bye ${session?.username ?? ''}`,
					result: 'quit',
					cause: 'user quit',
					mode: 'quit',
					username: session?.username ?? '',
				},
			});
		}
		// endSession, not destroySession: it deletes the row AND unlinks the media marker
		// this session's `dedalo_media_auth` cookie names. Logging out must revoke BOTH
		// credentials — see the note on clearMediaAuthCookie below.
		const { endSession } = await import('../../security/session_media.ts');
		if (context.sessionToken) {
			endSession(context.sessionToken);
		}
		// No SAML on this install, so no saml_redirect (the client falls back to
		// the standard SW-cleanup + root redirect when the field is absent).
		return {
			status: 200,
			body: ok(true, { requestId: context.requestId }),
			clearSessionCookie: true,
			// Clear the media-auth cookie too. UNCONDITIONAL, unlike PHP (which gated on
			// the mode): clearing an absent cookie costs nothing, while the conditional's
			// only real effect is to LEAVE a live authorization value in the browser of a
			// user who logs out just after an operator switched protection off — a value
			// that becomes valid again the moment it is switched back on.
			//
			// (!) THIS INVERTED ON 2026-08-24, and the old rule is worth keeping visible:
			// it used to read "must NEVER unlink the auth marker", because the cookie
			// value was install-global — every logged-in editor held today's value, so
			// unlinking it on one logout would have locked out all of them. The price
			// was that logging out revoked nothing a thief actually needed: the media
			// cookie kept working for up to ~48 hours, and a password reset could not
			// take it away either. The credential is now per SESSION, so `endSession`
			// above unlinks THIS session's marker and no other, and clearing the browser
			// cookie is the second half of a revocation rather than the whole of it.
			clearMediaAuthCookie: true,
		};
	},
	convert_search_object_to_sql_query: async (rqo, context) => {
		// SQO → SQL dev console (PHP dd_utils_api::convert_search_object_to_sql_query,
		// the sqo_test_environment maintenance widget). Global-admin only. The client
		// SQO is scrubbed by sanitizeClientSqo (the API-boundary security gate), built
		// to SQL by the standard search assembler, then executed. Response mirrors PHP:
		// msg = resolved SQL (params substituted), sql = template, ar_section_id =
		// distinct returned ids, db_data = rows.
		const principal = requirePrincipal(context);
		if (!principal.isGlobalAdmin) {
			// `perm.denied` is OPERATOR disclosure, so the sentence never reaches the
			// wire — it is the named LOG line (and what the gate below reads).
			throw new DedaloError('perm.denied', {
				publicMessage: 'Only global admins can use the SQO test environment',
				message: 'Only global admins can use the SQO test environment',
				coordinates: { action: 'convert_search_object_to_sql_query' },
			});
		}
		const untrusted = (rqo.options ?? {}) as Record<string, unknown>;
		try {
			const { sanitizeClientSqo } = await import('../../concepts/sqo.ts');
			const { buildSearchSql } = await import('../../search/sql_assembler.ts');
			const { runSearch, searchStatementText } = await import('../../search/search_statement.ts');
			const sqo = sanitizeClientSqo(untrusted);
			const built = await buildSearchSql(sqo, { principal });
			// The text is SHOWN (the console's answer); the statement RUNS through
			// the one search executor (bounded when a referenced_by leaf rendered).
			const shown = searchStatementText(built);
			const resolved = resolveSqlForDisplay(shown.sql, shown.params);
			const rows = await runSearch<Record<string, unknown>>(built);
			const arSectionId = [
				...new Set(
					rows.map((row) => row.section_id).filter((id) => id !== undefined && id !== null),
				),
			];
			return {
				status: 200,
				// The console's ANSWER is the four pieces together, so they are the
				// payload — not three top-level keys beside a boolean. PHP shipped the
				// resolved SQL in `msg` (the human channel); envelope v2 has no prose
				// channel, so it is a named field (`sql_resolved`) of the data.
				body: ok(
					{
						sql_resolved: resolved,
						sql: shown.sql,
						ar_section_id: arSectionId,
						db_data: rows,
					},
					{ requestId: context.requestId },
				),
			};
		} catch (error) {
			// A TYPED refusal keeps its code (the leaf bound's 503 db.statement_timeout,
			// a request.invalid_options / search.invalid_sqo, a perm.denied): re-wrapped
			// it would read as a 500 search.failed. Only an untyped throw is wrapped.
			if (isDedaloError(error)) throw error;
			throw new DedaloError('search.failed', {
				cause: error,
				message: 'convert_search_object_to_sql_query: build/execute failed',
			});
		}
	},
	get_server_ready_status: async (rqo, context) => {
		// Remote reachability probe (PHP dd_utils_api::get_server_ready_status).
		// Machine-to-machine, pre-auth (NO_LOGIN + CSRF-exempt like PHP): the
		// only branch implemented is the ontology-server check; anything else
		// answers the PHP default refusal. Fail-closed on the config flag.
		const options = (rqo.options ?? {}) as { check?: unknown };
		if (options.check === 'ontology_server' && config.ontologyIo.isOntologyServer === true) {
			return { status: 200, body: ok(true, { requestId: context.requestId }) };
		}
		if (options.check === 'code_server' && config.update.isCodeServer === true) {
			return { status: 200, body: ok(true, { requestId: context.requestId }) };
		}
		// ONE refusal for every reason (see `update_server.refused` in the registry):
		// a probe must not be able to tell "not that kind of server" from
		// "unknown check" by elimination. PHP refusal bytes preserved.
		throw new DedaloError('update_server.refused', {
			publicMessage: 'Error. This is not an accessible Server',
		});
	},
	get_ontology_update_info: async (rqo, context) => {
		// Ontology-update manifest (PHP dd_utils_api::get_ontology_update_info):
		// served ONLY when this instance is an ontology master, to callers
		// presenting a configured access code. PHP refusal bytes preserved.
		const options = (rqo.options ?? {}) as {
			version?: unknown;
			code?: unknown;
			channel?: unknown;
		};
		const auth = authorizeUpdateManifest({
			isServer: config.ontologyIo.isOntologyServer === true,
			configuredCodes: [
				config.ontologyIo.serverCode,
				...config.ontologyIo.servers.map((entry) => entry.code),
			],
			// The localhost pseudo-code is always honored on a master (the panel's
			// 'Local files' source posts it to our own API).
			allowLocalhost: true,
			presentedCode: options.code,
			versionRaw: options.version,
			requiredParts: 2,
			serverKind: 'ontology',
		});
		if (auth.ok !== true) {
			throw new DedaloError('update_server.refused', { publicMessage: auth.msg });
		}
		const originRefusal = localOriginRefusal({
			originIsLocal: publicOriginIsLocal(),
			clientIp: context.clientIp,
		});
		if (originRefusal !== null) {
			throw new DedaloError('update_server.refused', { publicMessage: originRefusal });
		}
		const [major, minor] = auth.version as [number, number];
		const { getOntologyIoPath, buildOntologyUpdateInfo } = await import(
			'../../ontology/data_io_import.ts'
		);
		const ioPath = getOntologyIoPath(config.ops.ontologyDataIoDir, [major, minor]);
		if (ioPath === false) {
			throw new DedaloError('update_server.refused', {
				publicMessage:
					'Error. Invalid version number. This version does not contain ontology files. ',
			});
		}
		const publicBaseUrl = `${publicOrigin()}/dedalo/install/import/ontology/${major}.${minor}`;
		// buildOntologyUpdateInfo answers a `{data, msg, errors}` PAYLOAD
		// (src/core/ontology/data_io_import.ts); only `data` travels, wrapped by
		// the one success builder.
		const manifest = buildOntologyUpdateInfo(ioPath, publicBaseUrl);
		return { status: 200, body: ok(manifest.data, { requestId: context.requestId }) };
	},
	get_code_update_info: async (rqo, context) => {
		// Code-release manifest (PHP dd_utils_api::get_code_update_info): served
		// ONLY when this instance is a code master, to callers presenting a
		// configured CODE_SERVERS code. PHP refusal bytes preserved. Advertises
		// only built release archives on the caller's linear upgrade path.
		// `version` is the asker's DATA triple (a bare `X.Y.Z` — the shape every
		// master, older ones included, parses); `release` is its RELEASE
		// IDENTITY (`7.0.0-beta.6`), optional: it places the asker in the
		// release sequence, so a prerelease install is offered what sits ABOVE
		// it in its own triple (code_manifest.ts askerIdentity — validated
		// there, never trusted as given). Never parsed for the triple
		// (WC-2026-10-15-release-identity-from-tag).
		const options = (rqo.options ?? {}) as {
			version?: unknown;
			release?: unknown;
			code?: unknown;
			channel?: unknown;
		};
		const auth = authorizeUpdateManifest({
			isServer: config.update.isCodeServer === true,
			configuredCodes: config.update.codeServers.map((entry) => entry.code),
			// No localhost pseudo-code here: a code master only answers configured peers.
			allowLocalhost: false,
			presentedCode: options.code,
			versionRaw: options.version,
			requiredParts: 3,
			serverKind: 'code',
		});
		if (auth.ok !== true) {
			throw new DedaloError('update_server.refused', { publicMessage: auth.msg });
		}
		const originRefusal = localOriginRefusal({
			originIsLocal: publicOriginIsLocal(),
			clientIp: context.clientIp,
		});
		if (originRefusal !== null) {
			throw new DedaloError('update_server.refused', { publicMessage: originRefusal });
		}
		const clientVersion = auth.version;
		const { buildCodeUpdateInfo, RELEASE_NOTES_DIR } = await import(
			'../../update/code_manifest.ts'
		);
		const { isInstallChannel } = await import('../../update/install_stamp.ts');
		const info = buildCodeUpdateInfo({
			clientVersion,
			serverVersion: DEDALO_DATA_VERSION,
			codeFilesDir: config.update.codeFilesDir,
			publicBaseUrl: `${publicOrigin()}/dedalo/install/code`,
			// The consumer's panel choice. Anything but an exact channel token is
			// the release channel, and a token only matters on a master that
			// opted into that channel. `prerelease` is new (RELEASE_IDENTITY_DESIGN
			// §2.8); an OLDER master parses `=== 'dev' ? 'dev' : 'master'` and so
			// answers a prerelease ask as a release one — never a refusal — which
			// the client reads from the absent `info.channels` (update_code_channel.js).
			channel: isInstallChannel(options.channel) ? options.channel : 'master',
			clientRelease: options.release,
			devChannelEnabled: config.update.devChannelEnabled,
			prereleaseChannelEnabled: config.update.prereleaseChannelEnabled,
			// the master's own frozen release notes (changes/<version>/release.json,
			// WC-2026-10-09-code-manifest-release-notes)
			changesDir: RELEASE_NOTES_DIR,
			info: {
				date: new Date().toISOString(),
				entity_id: config.identity.entityId,
				entity: config.entity,
				// This REPORTS our hostname rather than building a URL, so an unconfigured
				// install honestly says "unknown" ('') instead of claiming to be localhost.
				host: readString('DEDALO_HOST'),
			},
		});
		return { status: 200, body: ok(info, { requestId: context.requestId }) };
	},
};
