/**
 * THE AUTHORIZATION-DOOR MATRIX — closure Step 3's step gate.
 *
 * ONE behavioural matrix over every door this step owns, with the door list
 * DERIVED from the registries that already exist (no fourth census):
 *
 *   - READ_DOOR_POSTURE (security/read_door.ts) — its `mutating` rows, its
 *     `component` rows (DELEGATED only when test/helpers/read_door_probes.ts
 *     lists them — read_door_acl_native proves each of those legs completed;
 *     the `gate` label alone is not evidence), and
 *     every row of the two media classes (dd_component_av_api / _3d_api);
 *   - every loaded tool's apiActions of kind record / record_tipo / tipo /
 *     targets, plus tool_transcription's record doors (permission:null,
 *     gated in-handler);
 *   - the MCP TOOL_REGISTRY search / count tools and every `write` tool;
 *   - `mcpApiActions` (the agent door).
 *
 * An empty derivation throws. Every derived door is either PROBED here, or
 * DELEGATED (a `component` row naming READ_DOOR_GATE AND listed in
 * READ_DOOR_PROBED), or listed in the shrink-only
 * NOT_YET_PROBED with its reason — a new door that is none of the three is RED.
 *
 * THE IDENTITIES (authz_door_fixture, asserted through the real resolver first):
 *   NO_SECTION   the components at 2, the SECTION at an explicit 0
 *   NO_COMPONENT the section at 2, the COMPONENT at an explicit 0
 *   OUT_OF_SCOPE every grant, the record in a project it does not hold
 *   NO_TOOL      every grant, tool_assistant NOT authorized
 *   DD1725       a (dd128, dd1725) user-manager on their OWN account
  *   ADMIN_ID0    a GLOBAL ADMIN addressing a non-positive record id (SEC-05) —
 *                ALWAYS on the scratch section (test3/-1), never root's dd128/-1:
 *                a regressed door would WRITE (or delete) what the cell aims at,
 *                and the refusal rule is id-generic (root's own record is probed
 *                gate-only, write_door_native leg b)

 *   READ_ONLY    the section and components at 1 — may search, may not create
 *   ADMIN_CAPPED the SUPERUSER on a consultation-only section (Activity dd542):
 *                the cap is the only thing that can refuse it
  *   NO_SOURCE    the transcript writable (2), the AV SOURCE at 0 (TOOLS-06)
 *   TRANSCRIBER  the transcript writable (2), the AV at READ (1) — the typical
 *                transcriber profile: every transcription door serves it past
 *                the gate (one level on the AV for every WAV-deriving path)
 *   READ_COMPONENT the section writable (2), every media component and both
 *                transcripts at READ (1): past a write door's section floor, so
 *                ONLY the level-2 pair can refuse it — the column that separates
 *                a write action from one authorized in read mode (media writes,
 *                the transcript write, a record_tipo/tipo write kind)
 *   READ_SECTION the mirror: the section at READ (1), every media component
 *                WRITABLE (2) — past a write door's pair, so ONLY the section
 *                floor can refuse it (the media writes keep HEAD's floor 2)

 *   CONTROL      every grant, in scope (the tool-granted twin at the agent door)
 * — and CONTROL is the anti-vacuity column: a door that refuses everything is
 * red on it.
 *
 * A REFUSAL MUST BE THE RIGHT ONE. A DD1725 cell (and any cell a probe pins in
 * `refusalTipo`) counts as refused ONLY when the door answered `perm.denied`
 * naming the pinned component: a grammar refusal (`request.invalid*`) or a
 * denial on ANOTHER component (a second gate further down) would let the rule
 * under test disappear with the cell still green. Where the door speaks through
 * an opaque channel (a tool PermissionCheck sentence, a wire envelope — the
 * coordinates are log-only there) the code must still be `perm.denied`, and
 * the probe's only target IS the pinned pair.
 *
 * `DD128_PROBED` (test/helpers/authz_door_probes.ts) — the doors whose DD1725
 * leg proves a census file `delegates` — is read by the dd128 write census; this
 * matrix asserts that every door it lists IS probed here with a DD1725 column
 * that answers `refused`. The census checks the membership, the matrix the
 * outcome (a helper, because a TEST file imported by another registers its
 * tests twice).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TOOL_REGISTRY } from '../../src/ai/mcp/registry.ts';
import {
	duplicateRecord,
	findOrCreate,
	portalUnlink,
	setField,
} from '../../src/ai/mcp/tools/fields_write.ts';
import { uploadMedia } from '../../src/ai/mcp/tools/media.ts';
import { searchSectionRecords } from '../../src/ai/mcp/tools/records_read.ts';
import {
	createRecord,
	deleteRecord,
	saveComponentValue,
} from '../../src/ai/mcp/tools/records_write.ts';
import { countRecords, searchRecords } from '../../src/ai/mcp/tools/search.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { ActionHandler, ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { component3dApiActions } from '../../src/core/api/handlers/dd_component_3d_api.ts';
import { componentAvApiActions } from '../../src/core/api/handlers/dd_component_av_api.ts';
import { componentPortalApiActions } from '../../src/core/api/handlers/dd_component_portal_api.ts';
import { componentTextAreaApiActions } from '../../src/core/api/handlers/dd_component_text_area_api.ts';
import { mcpApiActions } from '../../src/core/api/handlers/dd_mcp_api.ts';
import { resolveMediaActionContext } from '../../src/core/api/handlers/media_action_context.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { writeMediaCompanions } from '../../src/core/media/ingest/companion_writes.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	getPermissionGrant,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { READ_DOOR_GATE, READ_DOOR_POSTURE } from '../../src/core/security/read_door.ts';
import { createSession, getSession, type Session } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { planCsvImport } from '../../src/core/tools/import_csv.ts';
import { executeCsvImport } from '../../src/core/tools/import_csv_execute.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import { loadToolModules } from '../../src/core/tools/loader.ts';
import type {
	GatedToolActionSpec,
	ToolActionContext,
	ToolActionSpec,
} from '../../src/core/tools/module.ts';
import { assertActionPermission } from '../../src/core/tools/security.ts';
import { setComponentsData } from '../../tools/tool_import_files/server/index.ts';
import { executeRdfImport } from '../../tools/tool_import_rdf/server/rdf_import_execute.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import {
	AUTHZ_3D,
	AUTHZ_AV,
	AUTHZ_CONTROL_USER_ID,
	AUTHZ_FILTER,
	AUTHZ_IMAGE,
	AUTHZ_PROJECT_P,
	AUTHZ_SECTION,
	AUTHZ_STUB_MODEL_ID,
	AUTHZ_TEXT,
	AUTHZ_TEXT_2,
	AUTHZ_TEXT_AREA,
	AUTHZ_USER_MANAGER_PROFILE_ID,
	AUTHZ_USER_MANAGER_USER_ID,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	authzProfileId,
	authzProjectLocator,
	authzStubAgentModels,
	clearAuthzDoorCaches,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DD128_PROBED } from '../helpers/authz_door_probes.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { READ_DOOR_PROBED } from '../helpers/read_door_probes.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

type IdentityKey =
	| 'NO_SECTION'
	| 'NO_COMPONENT'
	| 'OUT_OF_SCOPE'
	| 'NO_TOOL'
	| 'DD1725'
	| 'ADMIN_ID0'
	| 'READ_ONLY'
	| 'ADMIN_CAPPED'
	| 'NO_SOURCE'
	| 'TRANSCRIBER'
	| 'READ_COMPONENT'
	| 'READ_SECTION'
	| 'CONTROL';
type Verdict = 'refused' | 'served';
interface Outcome {
	verdict: Verdict;
	detail: string;
	/** The refusal's registry code (tool sentences mapped back to theirs). */
	code?: string;
	/** The refused component, when the channel carries coordinates. */
	tipo?: string;
	/** True when the channel cannot carry coordinates (tool check / wire envelope). */
	opaque?: boolean;
}
interface Probe {
	expect: Partial<Record<IdentityKey, Verdict>>;
	/** The component a refused cell must be denied ON (DD1725 defaults to dd1725). */
	refusalTipo?: Partial<Record<IdentityKey, string>>;
	run: (identity: IdentityKey) => Promise<Outcome>;
}

const USERS = 'dd128';
const MATRIX_TEXT = 'zzauthz matrix text';

// --- outcome classification ----------------------------------------------------

/** A DOOR refusal: an authorization or target-grammar code. Anything else is past the door. */
function isDoorRefusalCode(code: string): boolean {
	return (
		code.startsWith('perm.') || code === 'tool.not_authorized' || code.startsWith('request.invalid')
	);
}

/** The tool envelope's sentences, mapped back to the write door's codes (tools/security.ts toCheck). */
const TOOL_SENTENCE_CODES: Readonly<Record<string, string>> = {
	'insufficient permissions on target': 'perm.denied',
	'record is out of the user scope': 'perm.out_of_scope',
};

function checkOutcome(check: { msg?: string; errors?: string[] }): Outcome {
	const msg = check.msg ?? '';
	const code =
		TOOL_SENTENCE_CODES[msg] ?? (check.errors?.[0] === 'invalid_request' ? 'request.invalid' : msg);
	return { verdict: 'refused', detail: `${check.errors?.[0] ?? ''}: ${msg}`, code, opaque: true };
}

function envelopeOutcome(value: { status: number; body?: { error?: { code?: string } } }): Outcome {
	const code = value.body?.error?.code ?? '';
	if (code !== '' && isDoorRefusalCode(code)) {
		return { verdict: 'refused', detail: code, code, opaque: true };
	}
	return { verdict: 'served', detail: code === '' ? `status ${value.status}` : code };
}

function errorOutcome(error: DedaloError): Outcome {
	if (!isDoorRefusalCode(error.code)) {
		return { verdict: 'served', detail: `past the door: ${error.code}` };
	}
	const tipo = error.coordinates?.tipo;
	return {
		verdict: 'refused',
		detail: `${error.code}${tipo === undefined ? '' : ` on ${String(tipo)}`}`,
		code: error.code,
		...(tipo === undefined ? {} : { tipo: String(tipo) }),
	};
}

async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
	try {
		const value = await run();
		// assertActionPermission answers a PermissionCheck.
		if (
			value !== null &&
			typeof value === 'object' &&
			'ok' in value &&
			(value as { ok: unknown }).ok === false
		) {
			return checkOutcome(value as { msg?: string; errors?: string[] });
		}
		// A dispatch result carries an envelope.
		if (value !== null && typeof value === 'object' && 'status' in value && 'body' in value) {
			return envelopeOutcome(value as { status: number; body?: { error?: { code?: string } } });
		}
		return { verdict: 'served', detail: 'resolved' };
	} catch (error) {
		if (error instanceof DedaloError) return errorOutcome(error);
		throw error;
	}
}

/**
 * The cell's verdict against the design: the verdict itself, and — for a
 * refused cell with a pinned component — `perm.denied` ON that component.
 */
function cellMismatch(probe: Probe, identity: IdentityKey, expected: Verdict, outcome: Outcome) {
	if (outcome.verdict !== expected) return `expected ${expected}, got ${outcome.verdict}`;
	if (expected !== 'refused') return null;
	const pinned = probe.refusalTipo?.[identity] ?? (identity === 'DD1725' ? 'dd1725' : undefined);
	if (pinned === undefined) return null;
	if (outcome.code !== 'perm.denied')
		return `expected perm.denied ON ${pinned}, got ${outcome.code}`;
	if (outcome.opaque !== true && outcome.tipo !== pinned) {
		return `expected perm.denied ON ${pinned}, got it ON ${outcome.tipo ?? '(none)'}`;
	}
	return null;
}

// --- disposable records (the lifecycle doors' CONTROL leg) --------------------

/** Records a probe may delete or mint (duplicate) — swept tolerantly in afterAll. */
const disposable: { sectionTipo: string; sectionId: number }[] = [];

/** An engine-built test3 record in project P that the CONTROL's delete may consume. */
async function disposableRecord(): Promise<number> {
	await assertTestDatabase('authz_door_matrix_native: disposable record');
	const sectionId = await createSectionRecord(AUTHZ_SECTION, -1, new Date(), undefined, {
		filterData: [authzProjectLocator()],
	});
	disposable.push({ sectionTipo: AUTHZ_SECTION, sectionId });
	const saved = await saveComponentData({
		componentTipo: 'test101',
		sectionTipo: AUTHZ_SECTION,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', key: null, value: [authzProjectLocator()] } as never],
		userId: -1,
	});
	if (!saved.ok) throw new Error(`disposable record: membership save failed (${saved.message})`);
	return sectionId;
}

/**
 * SAFETY for the multi-delete probe: the SQO must select AT MOST the one pinned
 * record (none on a section the probe does not write) — verified with the
 * engine's own assembler BEFORE the delete is sent, so a sanitizer that dropped
 * the pin can never turn the CONTROL leg into a whole-section delete.
 */
async function assertSqoPinsAtMostOne(
	sqo: Record<string, unknown>,
	sectionTipo: string,
	pinned: number,
): Promise<void> {
	const { sanitizeClientSqo } = await import('../../src/core/concepts/sqo.ts');
	const { buildSearchSql } = await import('../helpers/search_sql.ts');
	const { sql } = await import('../../src/core/db/postgres.ts');
	const built = await buildSearchSql(sanitizeClientSqo(structuredClone(sqo)), { idsOnly: true });
	const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as {
		section_tipo: string;
		section_id: number | string;
	}[];
	const other = rows.filter(
		(row) => row.section_tipo !== sectionTipo || Number(row.section_id) !== pinned,
	);
	if (other.length > 0 || rows.length > 1) {
		throw new Error(
			`authz matrix: the multi-delete SQO selects ${rows.length} row(s), not just ${sectionTipo}/${pinned} — refusing to send it`,
		);
	}
}

async function sweepDisposable(): Promise<void> {
	await assertTestDatabase('authz_door_matrix_native: sweep');
	const { deleteMatrixRecord } = await import('../../src/core/db/matrix_write.ts');
	const { sql } = await import('../../src/core/db/postgres.ts');
	const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
	// A REGRESSED ADMIN_ID0 cell may have written the scratch section's
	// non-positive id (no genuine record ever holds one): swept, tolerantly.
	const scratchTable = await getMatrixTableFromTipo(AUTHZ_SECTION);
	if (scratchTable === null) throw new Error(`no matrix table for ${AUTHZ_SECTION}`);
	for (const sectionId of [-1, 0]) {
		await deleteMatrixRecord(scratchTable, AUTHZ_SECTION, sectionId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[AUTHZ_SECTION, sectionId],
		);
	}
	while (disposable.length > 0) {
		const record = disposable.pop() as { sectionTipo: string; sectionId: number };
		const table = await getMatrixTableFromTipo(record.sectionTipo);
		if (table === null) throw new Error(`no matrix table for ${record.sectionTipo}`);
		// Tolerant: the CONTROL's delete legitimately consumed some of these.
		await deleteMatrixRecord(table, record.sectionTipo, record.sectionId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
}

// --- identity plumbing ---------------------------------------------------------

let ids: AuthzIdentities;
let superuser: Principal;
let recordId = 0;
const sessions = new Map<number, Session>();

/** Activity — a consultation-only section: the superuser's level there caps at read. */
const CONSULTATION_ONLY = 'dd542';

function principalOf(identity: IdentityKey): Principal {
	switch (identity) {
		case 'NO_SECTION':
			return ids.componentOnly;
		case 'NO_COMPONENT':
			return ids.sectionOnly;
		case 'OUT_OF_SCOPE':
			return ids.outOfScope;
		case 'NO_TOOL':
			return ids.control;
		case 'DD1725':
			return ids.userManager;
		case 'ADMIN_ID0':
			return ids.dd128Admin;
		case 'READ_ONLY':
			return ids.level1;
		case 'ADMIN_CAPPED':
			return superuser;
		case 'NO_SOURCE':
			return ids.textOnly;
		case 'TRANSCRIBER':
			return ids.transcriber;
		case 'READ_COMPONENT':
			return ids.readComponent;
		case 'READ_SECTION':
			return ids.readSection;

		case 'CONTROL':
			return ids.control;
	}
}

/**
 * The record target an identity probes: its own dd128 account (DD1725), a
 * non-positive id ON THE SCRATCH SECTION (ADMIN_ID0 — never root's record, which
 * a regressed door would overwrite), or the scratch record.
 */
function recordTarget(identity: IdentityKey, componentTipo: string) {
	if (identity === 'DD1725') {
		return { section_tipo: USERS, tipo: 'dd1725', section_id: AUTHZ_USER_MANAGER_USER_ID };
	}
	if (identity === 'ADMIN_ID0')
		return { section_tipo: AUTHZ_SECTION, tipo: componentTipo, section_id: -1 };
	return { section_tipo: AUTHZ_SECTION, tipo: componentTipo, section_id: recordId };
}

function sessionFor(principal: Principal): Session {
	let session = sessions.get(principal.userId);
	if (session === undefined) {
		const token = createSession(
			principal.userId,
			`zzauthz_${principal.userId}`,
			principal.isGlobalAdmin,
		);
		session = getSession(token) as Session;
		sessions.set(principal.userId, session);
	}
	return session;
}

const handlerContext = (principal: Principal): ApiRequestContext =>
	({
		requestId: 'authz-matrix',
		clientIp: '127.0.0.1',
		session: sessionFor(principal),
		csrfCandidate: null,
		principal,
	}) as ApiRequestContext;

const dispatchContext = (principal: Principal) => {
	const session = sessionFor(principal);
	return {
		requestId: crypto.randomUUID(),
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session.csrfToken,
	};
};

// --- the probes ----------------------------------------------------------------

const FULL: Partial<Record<IdentityKey, Verdict>> = {
	NO_SECTION: 'refused',
	NO_COMPONENT: 'refused',
	OUT_OF_SCOPE: 'refused',
	ADMIN_ID0: 'refused',
	CONTROL: 'served',
};

/** A tool action's DECLARATIVE gate — the door the dispatch runs before the handler. */
function toolKindProbe(spec: GatedToolActionSpec, key: string): Probe {
	const kind = spec.permission;
	const writes = (spec.minLevel ?? 2) >= 2;
	// A `record` door whose effect is ONE COMPONENT (RECORD_KIND_EFFECT) is the
	// open hole: its component cells are NOT certified here — the OPEN canary
	// below measures them as the hole they are, never as the design.
	const componentEffect = RECORD_KIND_EFFECT[key]?.effect === 'component';
	const expectations: Partial<Record<IdentityKey, Verdict>> =
		kind === 'record'
			? // A section-kind door: the component is not its question — which is
				// only correct for a door whose EFFECT is section-wide (the
				// RECORD_KIND_EFFECT census classifies every one of them).
				{
					NO_SECTION: 'refused',
					...(componentEffect ? {} : { NO_COMPONENT: 'served', READ_COMPONENT: 'served' }),
					OUT_OF_SCOPE: 'refused',
					ADMIN_ID0: 'refused',
					CONTROL: 'served',
				}
			: {
					...FULL,
					// The dd128 own-record DOWNGRADE forces the manager's OWN dd1725 to
					// READ (1): a write door refuses it, a READ door (minLevel 1) serves
					// it — reading one's own profile assignment is the rule, not a leak.
					DD1725: writes ? 'refused' : 'served',
					// The section at 2, the AV at 1: only a WRITE-level pair refuses it.
					READ_COMPONENT: writes ? 'refused' : 'served',
				};
	return {
		expect: expectations,
		...(kind !== 'record' && writes ? { refusalTipo: { READ_COMPONENT: AUTHZ_AV } } : {}),
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_AV);
			const options =
				kind === 'record'
					? { section_tipo: target.section_tipo, section_id: target.section_id }
					: target;
			return outcomeOf(() =>
				assertActionPermission(spec as ToolActionSpec, options, principalOf(identity)),
			);
		},
	};
}

/**
 * The `section` kind's DECLARATIVE gate (authorizeSectionTarget): the section
 * level, consultation-capped, then the scope of a NAMED record — the component
 * is not its question. Probed with a named record so the scope half runs.
 */
function sectionKindProbe(spec: GatedToolActionSpec): Probe {
	const writes = (spec.minLevel ?? 2) >= 2;
	return {
		expect: {
			NO_SECTION: 'refused',
			NO_COMPONENT: 'served',
			OUT_OF_SCOPE: 'refused',
			ADMIN_ID0: 'refused',
			READ_ONLY: writes ? 'refused' : 'served',
			CONTROL: 'served',
		},
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_AV);
			return outcomeOf(() =>
				assertActionPermission(
					spec as ToolActionSpec,
					{ section_tipo: target.section_tipo, section_id: target.section_id },
					principalOf(identity),
				),
			);
		},
	};
}

/**
 * The `developer` kind: the developer flag is the whole gate (no section or
 * record target — module.ts). CONTROL is the SUPERUSER (a developer); every
 * fixture identity is a non-developer and is refused.
 */
function developerKindProbe(spec: GatedToolActionSpec): Probe {
	return {
		expect: { NO_SECTION: 'refused', ADMIN_ID0: 'refused', CONTROL: 'served' },
		run: (identity) =>
			outcomeOf(() =>
				assertActionPermission(
					spec as ToolActionSpec,
					{},
					identity === 'CONTROL' ? superuser : principalOf(identity),
				),
			),
	};
}

function mediaProbe(
	handler: ActionHandler,
	action: string,
	model: 'component_av' | 'component_3d',
	tipo: string,
	minLevel: 1 | 2,
): Probe {
	return {
		// READ_COMPONENT (section 2, the component 1): a WRITE action is refused
		// ON the component — the pair half, which the section floor cannot
		// answer for it — and a READ action serves it. READ_SECTION (section 1,
		// the component 2) is the mirror: only the section floor at 2 refuses a
		// write (media_action_context_native pins the refusal on the SECTION half).
		expect: {
			...FULL,
			READ_COMPONENT: minLevel === 2 ? 'refused' : 'served',
			READ_SECTION: minLevel === 2 ? 'refused' : 'served',
		},
		...(minLevel === 2 ? { refusalTipo: { READ_COMPONENT: tipo } } : {}),
		run: (identity) => {
			const principal = principalOf(identity);
			const source = recordTarget(identity, tipo);
			const rqo = {
				action,
				source,
				options:
					action === 'move_file_to_dir'
						? {
								target_dir: 'posterframe',
								file_data: { name: 'a.jpg', key_dir: 'no_such_key', tmp_name: 'no_such_tmp' },
							}
						: {},
			} as unknown as Rqo;
			// A SERVED cell probes the gate itself (no media effect: CONTROL, and
			// READ_COMPONENT / READ_SECTION on a read action); every other identity
			// goes through the real handler, which must refuse before any effect.
			return outcomeOf(() =>
				identity === 'CONTROL' ||
				((identity === 'READ_COMPONENT' || identity === 'READ_SECTION') && minLevel === 1)
					? resolveMediaActionContext(
							rqo,
							handlerContext(principal),
							minLevel,
							model,
							`matrix:${action}`,
						)
					: handler(rqo, handlerContext(principal)),
			);
		},
	};
}

function transcriptionProbe(
	handler: ToolActionSpec['handler'],
	optionsOf: (target: ReturnType<typeof recordTarget>) => Record<string, unknown>,
	/** The action WRITES the transcript: its DD1725 leg aims the write at the manager's own dd1725. */
	writesTranscript = false,
	/**
	 * The transcript this action AUTHORS (automatic_transcription's
	 * transcription_ddo, build_subtitles_file's VTT source): READ_COMPONENT holds
	 * it at 1 and must be refused ON it — the write level of that leg.
	 */
	authoredTranscript?: string,
	/**
	 * The action is the SHARED per-record WAV's lifecycle
	 * (create_ / delete_transcribable_audio_file): the SECTION at write (2), so
	 * the READ_ONLY viewer (section 1, AV 1) is refused — ON the AV pair's
	 * coordinates, by the section half.
	 */
	sharedWavLifecycle = false,
): Probe {
	return {
		// automatic_transcription also READS its media SOURCE (TOOLS-06): NO_SOURCE
		// passes the transcript's write gate and must be denied ON the AV.
		// TRANSCRIBER (AV at 1) is served past the gate by EVERY transcription door:
		// deriving a throwaway WAV / audio from the AV is a READ of it.
		expect: {
			...FULL,
			TRANSCRIBER: 'served',
			READ_COMPONENT: authoredTranscript === undefined ? 'served' : 'refused',
			// A transcript-authoring door refuses the viewer on the transcript; the
			// shared WAV's create / delete on the section half; the status poll serves it.
			READ_ONLY: authoredTranscript !== undefined || sharedWavLifecycle ? 'refused' : 'served',
			...(writesTranscript ? { DD1725: 'refused', NO_SOURCE: 'refused' } : {}),
		},
		refusalTipo: {
			...(writesTranscript ? { NO_SOURCE: AUTHZ_AV } : {}),
			...(authoredTranscript === undefined ? {} : { READ_COMPONENT: authoredTranscript }),
			...(sharedWavLifecycle ? { READ_ONLY: AUTHZ_AV } : {}),
		},
		run: (identity) => {
			const principal = principalOf(identity);
			const target = recordTarget(identity, AUTHZ_AV);
			const options = optionsOf(target);
			if (identity === 'DD1725' && writesTranscript) {
				// The own-record rule, not a missing pair grant: the transcript's
				// WRITE target is the manager's OWN (dd128, dd1725), which the profile
				// grants at 2 and the downgrade forces to 1.
				options.transcription_ddo = {
					component_tipo: target.tipo,
					section_tipo: target.section_tipo,
					section_id: target.section_id,
				};
			}
			const context = {
				principal,
				userId: principal.userId,
				options,
				background: false,
			};
			return outcomeOf(() => handler(context as ToolActionContext));
		},
	};
}

/**
 * tool_lang / tool_lang_multi `automatic_translation` (closure Step 3 req 10) —
 * an in-handler door: the REAL handler, whose first act after the parameter
 * check is the write door on (section, component, record). Every refused cell is
 * refused before any provider call. CONTROL is served PAST the door: its source
 * language holds nothing (`lg-zzz`), so the run ends on the empty slice — or on
 * the missing translator config — and never reaches a translator.
 */
function translationProbe(handler: ToolActionSpec['handler']): Probe {
	return {
		expect: { ...FULL, DD1725: 'refused', READ_COMPONENT: 'refused', READ_ONLY: 'refused' },
		refusalTipo: { NO_COMPONENT: AUTHZ_TEXT, READ_COMPONENT: AUTHZ_TEXT },
		run: (identity) => {
			const principal = principalOf(identity);
			const target = recordTarget(identity, AUTHZ_TEXT);
			const context = {
				principal,
				userId: principal.userId,
				options: {
					section_tipo: target.section_tipo,
					component_tipo: target.tipo,
					section_id: target.section_id,
					source_lang: 'lg-zzz',
					target_lang: 'lg-spa',
					translator: 'babel',
				},
				background: false,
			};
			return outcomeOf(() => handler(context as ToolActionContext));
		},
	};
}

/**
 * tool_posterframe `create_identifying_image`'s HOST (closure Step 3 req 10): the
 * in-handler write door on (host section, host portal, host record) — a door the
 * declarative gate (the AV SOURCE, record_tipo/1) never sees, so it is probed
 * through the REAL handler under its own key. The DD1725 leg aims the host at the
 * manager's own (dd128, dd1725). CONTROL is served PAST the door: its host
 * "portal" is a text component with no target section, so the handler stops at
 * `tool.unsupported_target` — before the image grant, the portal save, the frame
 * extract or any write.
 */
function posterframeHostProbe(handler: ToolActionSpec['handler']): Probe {
	return {
		expect: { ...FULL, DD1725: 'refused', READ_COMPONENT: 'refused' },
		refusalTipo: { NO_COMPONENT: AUTHZ_TEXT, READ_COMPONENT: AUTHZ_TEXT },
		run: (identity) => {
			const principal = principalOf(identity);
			const host = recordTarget(identity, AUTHZ_TEXT);
			const context = {
				principal,
				userId: principal.userId,
				options: {
					section_tipo: AUTHZ_SECTION,
					section_id: recordId,
					component_tipo: AUTHZ_AV,
					current_time: '1',
					item_value: {
						section_tipo: host.section_tipo,
						section_id: host.section_id,
						component_portal: host.tipo,
						component_image: AUTHZ_IMAGE,
					},
				},
				background: false,
			};
			return outcomeOf(() => handler(context as ToolActionContext));
		},
	};
}

/**
 * tool_update_cache `update_cache` (closure Step 3 req 10): its declarative
 * `targets` gate names (section, component) PAIRS with no record, so the per-ROW
 * write door in the handler is the half that judges the rows the sqo matches —
 * the dd128 own-record downgrade above all. Driven through the REAL handler with
 * an sqo pinned to the identity's one target; a refused row is SKIPPED and
 * reported (`data.refused`), never written, so a run that wrote nothing and
 * refused its row IS the refusal. The dd800 run record each run mints is swept.
 */
function updateCacheRowProbe(handler: ToolActionSpec['handler']): Probe {
	return {
		expect: { DD1725: 'refused', CONTROL: 'served' },
		run: async (identity) => {
			const principal = principalOf(identity);
			const target = recordTarget(identity, AUTHZ_TEXT);
			const context = {
				principal,
				userId: principal.userId,
				options: {
					section_tipo: target.section_tipo,
					sqo: {
						section_tipo: [target.section_tipo],
						filter_by_locators: [
							{ section_tipo: target.section_tipo, section_id: target.section_id },
						],
					},
					components_selection: [{ tipo: target.tipo }],
				},
				background: false,
			};
			try {
				const response = (await handler(context as ToolActionContext)) as {
					data?: { refused?: number; regenerated?: number; bulk_process_id?: number };
				};
				const data = response.data ?? {};
				if (typeof data.bulk_process_id === 'number') {
					disposable.push({ sectionTipo: 'dd800', sectionId: data.bulk_process_id });
				}
				if ((data.refused ?? 0) > 0 && (data.regenerated ?? 0) === 0) {
					return {
						verdict: 'refused',
						detail: `refused ${data.refused} row target(s)`,
						code: 'perm.denied',
						opaque: true,
					};
				}
				return { verdict: 'served', detail: `regenerated ${data.regenerated ?? 0}` };
			} catch (error) {
				if (error instanceof DedaloError) return errorOutcome(error);
				throw error;
			}
		},
	};
}

/**
 * THE INGEST COMPANIONS (closure Step 3 req 10, media/ingest/companion_writes.ts):
 * the ontology-declared siblings an upload writes (`target_filename` /
 * `target_duration`) are asked of the write door AS THE UPLOADER. Two scratch
 * media components declare their target: one names the manager's own dd1725
 * (the DD1725 leg — a dd128 field an ontology could point a companion at), the
 * other test162 (the CONTROL / NO_COMPONENT legs). The engine is driven directly
 * (it is the writer every ingest door shares); a refused companion is a MESSAGE
 * and nothing is written, so a "not writable" message IS the refusal.
 */
const COMPANION_SITUATION = situation({
	tld: 'zzcmp',
	name: 'authz matrix — ingest companions',
	nodes: [
		{ tipo: 'zzcmp1', parent: 'test1', model: 'section', term: { 'lg-eng': 'zz companions' } },
		{
			tipo: 'zzcmp2',
			parent: 'zzcmp1',
			model: 'component_image',
			term: { 'lg-eng': 'zz image → dd1725' },
			properties: { target_filename: 'dd1725' },
		},
		{
			tipo: 'zzcmp3',
			parent: 'zzcmp1',
			model: 'component_image',
			term: { 'lg-eng': 'zz image → test162' },
			properties: { target_filename: AUTHZ_TEXT_2 },
		},
	],
});

function companionProbe(): Probe {
	return {
		expect: { DD1725: 'refused', NO_COMPONENT: 'refused', CONTROL: 'served' },
		refusalTipo: { NO_COMPONENT: AUTHZ_TEXT_2 },
		run: (identity) =>
			outcomeOf(async () => {
				const principal = principalOf(identity);
				const dd128 = identity === 'DD1725';
				const messages = await writeMediaCompanions({
					componentTipo: dd128 ? 'zzcmp2' : 'zzcmp3',
					sectionTipo: dd128 ? USERS : AUTHZ_SECTION,
					sectionId: dd128 ? AUTHZ_USER_MANAGER_USER_ID : recordId,
					userId: principal.userId,
					originalFileName: 'zzauthz companion.jpg',
					mediaFilePath: '/zzauthz/no/such/file.jpg',
				});
				// The engine's own sentence names the refused target and the door's code:
				// "<role> '<tipo>': not writable by the uploader (<code>) — …".
				for (const message of messages) {
					const refused = /^\w+ '([a-z]+[0-9]+)': not writable by the uploader \(([a-z_.]+)\)/.exec(
						message,
					);
					if (refused !== null) {
						throw new DedaloError(refused[2] as 'perm.denied', {
							message,
							coordinates: { tipo: refused[1] as string },
						});
					}
				}
				return messages;
			}),
	};
}

/**
 * THE MAPPED-RECORD IMPORTER (closure Step 3 req 10, core/tools/import_execute.ts
 * — MARC21 / Zotero / RDF): every field of a MATCHED record is asked of the write
 * door as the importing principal. Its doors gate the SECTION once (no record
 * named); this engine is where a row's record meets the dd128 own-record rule.
 * A refused field is reported (`failed`, IGNORED — not written); the engine's
 * own sentence carries the door's code, and the failure names the field. The
 * run's dd800 record is swept.
 */
function importExecuteProbe(): Probe {
	return {
		expect: { DD1725: 'refused', NO_COMPONENT: 'refused', CONTROL: 'served' },
		refusalTipo: { NO_COMPONENT: AUTHZ_TEXT },
		run: (identity) =>
			outcomeOf(async () => {
				const principal = principalOf(identity);
				const target = recordTarget(identity, AUTHZ_TEXT);
				const field = identity === 'CONTROL' ? AUTHZ_TEXT_2 : target.tipo;
				const report = await importMappedRecords(
					[
						{
							sectionId: target.section_id,
							fields: [{ component_tipo: field, values: ['zzauthz import'] }],
						},
					],
					target.section_tipo,
					principal,
					{ bulkLabel: 'authz matrix import probe' },
				);
				if (report.bulkProcessId !== null) {
					disposable.push({ sectionTipo: 'dd800', sectionId: report.bulkProcessId });
				}
				for (const failure of report.failed) {
					const refused = /not writable by the importer \(([a-z_.]+)\)/.exec(String(failure.msg));
					if (refused !== null) {
						throw new DedaloError(refused[1] as 'perm.denied', {
							message: String(failure.msg),
							coordinates: { tipo: String(failure.component_tipo) },
						});
					}
				}
				return report;
			}),
	};
}

/**
 * tool_import_rdf's ONTOLOGY-DRIVEN EXECUTOR (tools/tool_import_rdf/server/
 * rdf_import_execute.ts): the caller record's component is asked of the write
 * door as the importer — one `write` op on the identity's target record. A
 * refused write is reported skipped (`not writable by the importer (<code>)`) and
 * never written; the run's dd800 record is swept.
 */
function rdfImportProbe(): Probe {
	return {
		expect: { DD1725: 'refused', NO_COMPONENT: 'refused', CONTROL: 'served' },
		refusalTipo: { NO_COMPONENT: AUTHZ_TEXT },
		run: (identity) =>
			outcomeOf(async () => {
				const principal = principalOf(identity);
				const target = recordTarget(identity, AUTHZ_TEXT);
				const field = identity === 'CONTROL' ? AUTHZ_TEXT_2 : target.tipo;
				const report = await executeRdfImport({
					caller: { section_tipo: target.section_tipo, section_id: target.section_id },
					plans: [
						{
							subject: 'http://zz.test/authz/rdf',
							class_tipo: null,
							section_tipo: target.section_tipo,
							ops: [
								{
									op: 'set',
									ontology_tipo: 'zzauthzrdf1',
									rdf_predicate: 'zz:probe',
									target: { kind: 'caller' },
									section_tipo: target.section_tipo,
									component_tipo: field,
									model: null,
									lang: 'lg-nolan',
									value: [{ value: 'zzauthz rdf' }],
								},
							],
						},
					],
					principal,
					bulkLabel: 'authz matrix rdf import probe',
				});
				if (report.bulk_process_id !== null) {
					disposable.push({ sectionTipo: 'dd800', sectionId: report.bulk_process_id });
				}
				for (const skipped of report.skipped) {
					const refused = /not writable by the importer \(([a-z_.]+)\)/.exec(skipped.reason);
					if (refused !== null) {
						throw new DedaloError(refused[1] as 'perm.denied', {
							message: skipped.reason,
							coordinates: { tipo: skipped.component_tipo },
						});
					}
				}
				// SERVED = the door admitted the write: it was written, or it reached the
				// never-overwrite check that runs only AFTER the door (the record's field
				// may already hold a value from an earlier probe). Anything else (an
				// unknown component, a rolled-back IRI) is not a served answer.
				const pastTheDoor = report.skipped.every((entry) => entry.reason.startsWith('not empty'));
				if (report.written.length + report.skipped.length === 0 || !pastTheDoor) {
					throw new Error(`rdf import probe did not reach the write: ${JSON.stringify(report)}`);
				}
				return report;
			}),
	};
}

/**
 * THE CSV IMPORTER (closure Step 3 req 10, core/tools/import_csv_execute.ts):
 * every column of an EXISTING row's record is asked of the write door as the
 * importer — the file door's `section_list` gate named the section once. A
 * one-row plan through the engine's own planner (`planCsvImport`): the row's
 * section_id is the identity's target record, its one column the target
 * component. A refused column is reported (IGNORED) and never written. The
 * probe mints the dd800 run record the executor stamps its saves with (the
 * tool's own door does that before calling it), and sweeps it.
 */
function csvImportProbe(): Probe {
	return {
		expect: { DD1725: 'refused', NO_COMPONENT: 'refused', CONTROL: 'served' },
		refusalTipo: { NO_COMPONENT: AUTHZ_TEXT },
		run: (identity) =>
			outcomeOf(async () => {
				const principal = principalOf(identity);
				const target = recordTarget(identity, AUTHZ_TEXT);
				const field = identity === 'CONTROL' ? AUTHZ_TEXT_2 : target.tipo;
				const { getModelByTipo } = await import('../../src/core/ontology/resolver.ts');
				const model = (await getModelByTipo(field)) ?? 'component_input_text';
				const plan = await planCsvImport(
					[[String(target.section_id), 'zzauthz csv']],
					[
						{
							tipo: 'section_id',
							model: 'component_section_id',
							columnName: 'section_id',
							lang: 'lg-nolan',
						},
						{ tipo: field, model, columnName: field, lang: 'lg-nolan' },
					],
					target.section_tipo,
				);
				const bulkProcessId = await createSectionRecord('dd800', -1);
				disposable.push({ sectionTipo: 'dd800', sectionId: bulkProcessId });
				const report = await executeCsvImport({
					plan,
					sectionTipo: target.section_tipo,
					principal,
					bulkProcessId,
					errors: [],
					notices: [],
					progress: {
						file: 'zzauthz.csv',
						fileIndex: 1,
						filesTotal: 1,
						labels: new Map(),
						publish: () => {},
					},
				});
				for (const failure of report.failed) {
					const refused = /not writable by the importer \(([a-z_.]+)\)/.exec(String(failure.msg));
					if (refused !== null) {
						throw new DedaloError(refused[1] as 'perm.denied', {
							message: String(failure.msg),
							coordinates: { tipo: String(failure.component_tipo) },
						});
					}
				}
				return report;
			}),
	};
}

/**
 * tool_import_files' ROLE WRITES (closure Step 3 req 10): an `input_component`
 * ddo writes the operator's value into the caller/target record at RUN TIME,
 * so its triple is asked of the write door at the write (`setComponentsData`).
 * The DD1725 leg aims the role at the manager's own (dd128, dd1725); CONTROL
 * writes test162 on the scratch record.
 */
function importFilesRoleProbe(): Probe {
	return {
		expect: {
			DD1725: 'refused',
			NO_COMPONENT: 'refused',
			OUT_OF_SCOPE: 'refused',
			CONTROL: 'served',
		},
		refusalTipo: { NO_COMPONENT: AUTHZ_TEXT },
		run: (identity) =>
			outcomeOf(() => {
				const principal = principalOf(identity);
				const target = recordTarget(identity, AUTHZ_TEXT);
				const field = identity === 'CONTROL' ? AUTHZ_TEXT_2 : target.tipo;
				return setComponentsData({
					ddoMap: [{ role: 'input_component', tipo: field, section_tipo: target.section_tipo }],
					sectionTipo: target.section_tipo,
					sectionId: target.section_id,
					targetSectionTipo: target.section_tipo,
					targetSectionId: target.section_id,
					currentFileName: 'zzauthz.jpg',
					mediaFilePath: null,
					targetComponentModel: 'component_image',
					componentsTempData: [
						{
							tipo: field,
							section_tipo: target.section_tipo,
							entries: [{ value: 'zzauthz role' }],
						},
					],
					userId: principal.userId,
					principal,
					dataLang: 'lg-eng',
				});
			}),
	};
}

/**
 * THE BULK REVERT'S WRITER (closure Step 3 req 10,
 * tool_time_machine/server/bulk_revert_undo.ts): every component a revert
 * unit writes is asked of the write door behind the unit's lock. The
 * orchestrator's pre-gate reads the RAW pair level, which the dd128 own-record
 * rule does not reach — so this probe measures the writer's door alone. A run
 * is built per cell: the superuser re-saves the identity's target under a fresh
 * dd800 id (the manager's OWN dd132 username for DD1725 — level 2 in the
 * profile, 1 by the own-record downgrade; test162 on the scratch record for
 * CONTROL), then the identity reverts it through the REAL handler. A refused
 * unit is SKIPPED `out_of_scope` and never written; the run and revert dd800
 * records are swept.
 */
function bulkRevertProbe(): Probe {
	return {
		expect: { DD1725: 'refused', CONTROL: 'served' },
		run: async (identity) => {
			const principal = principalOf(identity);
			const dd128 = identity === 'DD1725';
			const target = dd128
				? { section_tipo: USERS, tipo: 'dd132', section_id: AUTHZ_USER_MANAGER_USER_ID }
				: { section_tipo: AUTHZ_SECTION, tipo: AUTHZ_TEXT_2, section_id: recordId };
			const runId = await createSectionRecord('dd800', -1);
			disposable.push({ sectionTipo: 'dd800', sectionId: runId });
			const saved = await saveComponentData({
				componentTipo: target.tipo,
				sectionTipo: target.section_tipo,
				sectionId: target.section_id,
				lang: 'lg-nolan',
				changedData: [
					{
						action: 'set_data',
						key: null,
						value: [{ id: 1, lang: 'lg-nolan', value: `zzauthz_run_${crypto.randomUUID()}` }],
					} as never,
				],
				userId: -1,
				bulkProcessId: runId,
			});
			if (!saved.ok) throw new Error(`bulk revert probe: the run save failed (${saved.message})`);
			try {
				const response = (await toolTimeMachineBulkRevert({
					principal,
					userId: principal.userId,
					options: { bulk_process_id: runId, section_tipo: target.section_tipo },
					background: false,
				} as unknown as ToolActionContext)) as {
					data?: { counter?: number; bulk_process_id?: number; skipped?: { reason?: string }[] };
				};
				const data = response.data ?? {};
				if (typeof data.bulk_process_id === 'number') {
					disposable.push({ sectionTipo: 'dd800', sectionId: data.bulk_process_id });
				}
				const refused = (data.skipped ?? []).some((skip) => skip.reason === 'out_of_scope');
				if (refused && (data.counter ?? 0) === 0) {
					return {
						verdict: 'refused',
						detail: 'unit skipped out_of_scope',
						code: 'perm.denied',
						opaque: true,
					};
				}
				return { verdict: 'served', detail: `reverted ${data.counter ?? 0}` };
			} catch (error) {
				if (error instanceof DedaloError) return errorOutcome(error);
				throw error;
			}
		},
	};
}

/**
 * TIME MACHINE apply_value, SECTION branch (cross-write:r3,
 * tool_time_machine/server/tool_time_machine.ts): a whole-record restore asks
 * the write door for every component it CHANGES, behind the row lock
 * (persistRecordColumns' door). The declarative `tipo` gate reads the
 * (section, section) pair, which the dd128 own-record rule never reaches — so
 * this probe measures the handler's door alone, through the REAL handler. Per
 * cell a whole-record TM row is built from the identity's target's LIVE columns
 * with ONE key changed: DD1725 → the manager's OWN dd128 record, its dd1725 set
 * to another profile (level 2 in the profile, 1 by the own-record downgrade);
 * CONTROL → the scratch record, its AUTHZ_TEXT_2 set to a fresh value. A
 * regressed door that let DD1725 through is undone (the live dd1725 written
 * back as root) so no later cell runs on a manager with a foreign profile. The
 * TM row and the recover's activity rows are swept.
 */
function tmSectionApplyProbe(): Probe {
	return {
		expect: { DD1725: 'refused', CONTROL: 'served' },
		run: async (identity) => {
			await assertTestDatabase('authz_door_matrix_native: tm section apply_value');
			const { sql } = await import('../../src/core/db/postgres.ts');
			const { readMatrixRecord } = await import('../../src/core/db/matrix.ts');
			const { getColumnNameByModel, getModelByTipo, getMatrixTableFromTipo } = await import(
				'../../src/core/ontology/resolver.ts'
			);
			const { toolTimeMachineApplyValue } = await import(
				'../../tools/tool_time_machine/server/tool_time_machine.ts'
			);
			const { sweepActivityRows } = await import('../helpers/activity_rows.ts');
			const principal = principalOf(identity);
			const dd128 = identity === 'DD1725';
			const sectionTipo = dd128 ? USERS : AUTHZ_SECTION;
			const sectionId = dd128 ? AUTHZ_USER_MANAGER_USER_ID : recordId;
			const tipo = dd128 ? 'dd1725' : AUTHZ_TEXT_2;
			const table = await getMatrixTableFromTipo(sectionTipo);
			const column = getColumnNameByModel((await getModelByTipo(tipo)) ?? '');
			if (table === null || column === null) {
				throw new Error(`tm section probe: no table/column for ${sectionTipo}/${tipo}`);
			}
			const live = await readMatrixRecord(table, sectionTipo, sectionId);
			if (live === null) throw new Error(`tm section probe: ${sectionTipo}/${sectionId} absent`);
			const snapshot = structuredClone(live.columns) as Record<
				string,
				Record<string, unknown> | null
			>;
			const before = snapshot[column]?.[tipo];
			snapshot[column] = {
				...(snapshot[column] ?? {}),
				[tipo]: dd128
					? [
							{
								id: 1,
								type: 'dd151',
								section_id: authzProfileId(AUTHZ_CONTROL_USER_ID),
								section_tipo: 'dd234',
								from_component_tipo: 'dd1725',
							},
						]
					: [{ id: 1, lang: 'lg-nolan', value: `zzauthz_tm_${crypto.randomUUID()}` }],
			};
			const rows = (await sql.unsafe(
				`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
				 VALUES ($1, $2, $2, 'lg-nolan', '2026-07-01 10:00:00', -1, $3::text::jsonb) RETURNING id`,
				[sectionId, sectionTipo, JSON.stringify(snapshot)],
			)) as { id: number }[];
			const tmId = Number(rows[0]?.id);
			try {
				return await outcomeOf(() =>
					toolTimeMachineApplyValue({
						principal,
						userId: principal.userId,
						options: {
							section_tipo: sectionTipo,
							section_id: sectionId,
							tipo: sectionTipo,
							lang: 'lg-nolan',
							matrix_id: tmId,
						},
						background: false,
					} as unknown as ToolActionContext),
				);
			} finally {
				if (dd128) {
					const after = (await readMatrixRecord(table, sectionTipo, sectionId))?.columns as
						| Record<string, Record<string, unknown> | null>
						| undefined;
					if (JSON.stringify(after?.[column]?.[tipo]) !== JSON.stringify(before)) {
						// A REGRESSED door wrote the foreign profile: put the manager's own back.
						await saveComponentData({
							componentTipo: tipo,
							sectionTipo,
							sectionId,
							lang: 'lg-nolan',
							changedData: [{ action: 'set_data', key: null, value: before } as never],
							userId: -1,
						});
					}
					clearAuthzDoorCaches();
				}
				await sql.unsafe('DELETE FROM matrix_time_machine WHERE id = $1', [tmId]);
				await sweepActivityRows(sectionTipo, [sectionId]);
			}
		},
	};
}

/**
 * THE ACQUISITION TOOLS' FIXED-TARGET DOORS (PR #114 — tool_numisdata_acquisition,
 * tool_bibliography_acquisition). Each action declares `targets` with a CONSTANT
 * extractor: the previews name the tool's object section at READ (1), the
 * commits that section plus every (section, component) PAIR the handler writes
 * across its object, authority, entity and image sections at WRITE (2). The
 * client's own `section_tipo` is never consulted — the gate is input-blind.
 *
 * WHY OWN IDENTITIES. The shared fixture's identities hold their grants on the
 * playground section; none holds anything on a tool's fixed sections, so every
 * one of them is refused trivially and none could be the CONTROL. The
 * acquisition identities ({@link ACQ_IDENTITIES}) are DERIVED from the loaded
 * specs' own target lists (never typed here: the install TLDs stay out of this
 * file's source), minted in this file's band and verified through the resolver
 * before any cell runs:
 *
 *   ACQ_CONTROL     → CONTROL        every target at 2
 *   ACQ_READ_ONLY   → READ_ONLY      every target at 1 — may preview, may not commit
 *   ACQ_PAIR_SHORT  → READ_COMPONENT every target at 2 but the commit list's LAST
 *                                    component pair, explicitly at 1 — the gate must
 *                                    walk the whole list to refuse it; the refusal is
 *                                    PINNED there (the same principal is admitted the
 *                                    moment that one pair is dropped from the list)
 *   ACQ_NO_SECTION  → NO_SECTION     the target SECTIONS at an explicit 0, every pair at 2
 *
 * THE CELL'S VERDICT IS THE GATE'S (`assertActionPermission`, dispatch gate 7 —
 * src/core/tools/dispatch.ts runs it before the handler and before any
 * background fork). The handler is entered ONLY on a cell the design expects
 * SERVED, with an inert CONTROL payload; a refusal cell's payload is the
 * dangerous one (a URL the handler would FETCH, a lot it would WRITE), so a
 * regressed gate shows up as `served` — and is not then run. EVERY cell runs
 * under two guards that throw (red, never a verdict): any `fetch` reached
 * (globalThis.fetch is swapped for a refusing spy for the cell), and any row
 * written on the tool's target sections (matrix rows + TM rows, counted before
 * and after).
 *
 * The CONTROL payloads, each stopping before a network or a write by design:
 *   preview_url  numisdata: a numisbids sale URL — that adapter refuses to fetch
 *                (`tool.unsupported_target`, robots.txt) before any request;
 *                bibliography: an http:// OAI URL — the harvesting door's step 1
 *                refuses it (`harvest.refused`, https required) before DNS or a socket;
 *   preview_html a minimal saved page (one numisbids lot card / one OAI-PMH
 *                record) the parser must turn into exactly ONE lot / publication;
 *   commit_*     a one-entry batch whose entry is not an object — skipped by the
 *                loop, so the handler runs to its summary and writes NOTHING. A real
 *                write is not possible here: the commits write only the tools' FIXED
 *                install sections (no scratch section can be substituted), which the
 *                generic-TLD law keeps out of the suite database's records — and the
 *                numisdata sections are absent from the suite ontology altogether.
 */
const ACQ_BAND_LOW = 944100;
const ACQ_BAND_HIGH = 944199;
type AcqIdentity = 'ACQ_CONTROL' | 'ACQ_READ_ONLY' | 'ACQ_PAIR_SHORT' | 'ACQ_NO_SECTION';
const ACQ_IDENTITIES: Readonly<Record<AcqIdentity, { userId: number; column: IdentityKey }>> = {
	ACQ_CONTROL: { userId: 944101, column: 'CONTROL' },
	ACQ_READ_ONLY: { userId: 944102, column: 'READ_ONLY' },
	ACQ_PAIR_SHORT: { userId: 944103, column: 'READ_COMPONENT' },
	ACQ_NO_SECTION: { userId: 944104, column: 'NO_SECTION' },
};
const acqProfileOf = (userId: number) => userId + 10;

const ACQ_NUMISDATA = 'tool_numisdata_acquisition';
const ACQ_BIBLIOGRAPHY = 'tool_bibliography_acquisition';
/** The commit action of each acquisition tool — whose LAST pair ACQ_PAIR_SHORT holds at 1. */
const ACQ_COMMIT: Readonly<Record<string, string>> = {
	[ACQ_NUMISDATA]: 'commit_lots',
	[ACQ_BIBLIOGRAPHY]: 'commit_publications',
};

/** A minimal numisbids sale page: one `.browse` lot card, no sale header (no auction search). */
const NUMISBIDS_SAVED_PAGE =
	'<html><body><div class="browse"><div class="browsetext-top"><div class="left">' +
	'<span class="lot"><a href="/sale/1/lot/7">Lot 7</a></span></div></div>' +
	'<a class="watchlot" data-lotid="7"></a><div class="browsetext">' +
	'<div class="summary"><a>zzauthz coin</a></div></div></div></body></html>';
/** A minimal OAI-PMH response: one record, no dc:source (no series search). */
const OAI_SAVED_PAGE =
	'<?xml version="1.0" encoding="UTF-8"?><OAI-PMH><ListRecords><record><header>' +
	'<identifier>oai:zzauthz:article/1</identifier></header><metadata><oai_dc:dc>' +
	'<dc:title>zzauthz article</dc:title></oai_dc:dc></metadata></record></ListRecords></OAI-PMH>';

interface AcquisitionCase {
	/** The payload a REFUSED cell sends: one the handler would fetch or write with. */
	refused: Record<string, unknown>;
	/** The CONTROL payload: stops before any network or write (see the block above). */
	control: Record<string, unknown>;
	/** THROWS unless the handler's answer is the one the control payload must produce. */
	accept: (result: {
		value?: unknown;
		error?: unknown;
		/** False when the tool's OBJECT section has no matrix table in this database. */
		ontologyPresent: boolean;
	}) => void;
}

const dataOf = (value: unknown) =>
	(value as { data?: Record<string, unknown> } | undefined)?.data ?? {};
function acceptCode(code: string): AcquisitionCase['accept'] {
	return ({ error }) => {
		if (!(error instanceof DedaloError) || error.code !== code) {
			throw new Error(
				`acquisition control: expected the handler to stop on ${code}, got ${String(error)}`,
			);
		}
	};
}
function acceptParsed(key: 'lots' | 'publications'): AcquisitionCase['accept'] {
	return ({ value, error }) => {
		const parsed = dataOf(value)[key];
		if (error !== undefined || !Array.isArray(parsed) || parsed.length !== 1) {
			throw new Error(
				`acquisition control: expected ONE parsed entry in ${key}, got ${String(error ?? JSON.stringify(parsed))}`,
			);
		}
	};
}
/**
 * A commit's CONTROL: the one non-object entry is skipped, so the summary counts
 * it and holds no result. ONE derived exception: where the tool's install
 * ontology is ABSENT from this database (the suite database carries no
 * numisdata TLD), the handler's first act — a READ of its fixed authority list
 * (the catalogue index) — stops on `request.invalid_tipo` after the gate, before
 * any write. Accepted only then: on a database holding the ontology the empty
 * summary is required.
 */
function acceptEmptyCommit(total: 'lots_total' | 'publications_total'): AcquisitionCase['accept'] {
	return ({ value, error, ontologyPresent }) => {
		if (!ontologyPresent && error instanceof DedaloError && error.code === 'request.invalid_tipo') {
			return;
		}
		const data = dataOf(value);
		if (
			error !== undefined ||
			data[total] !== 1 ||
			!Array.isArray(data.results) ||
			data.results.length !== 0
		) {
			throw new Error(
				`acquisition control: expected an empty commit summary, got ${String(error ?? JSON.stringify(data))}`,
			);
		}
	};
}

const ACQUISITION_CASES: Readonly<Record<string, AcquisitionCase>> = {
	[`tool:${ACQ_NUMISDATA}:preview_url`]: {
		refused: { url: 'https://www.jesusvico.com/es/subasta-1-zzauthz_I1-001' },
		control: { url: 'https://www.numisbids.com/sale/1' },
		accept: acceptCode('tool.unsupported_target'),
	},
	[`tool:${ACQ_NUMISDATA}:preview_html`]: {
		refused: { url: 'https://www.numisbids.com/sale/1', html: NUMISBIDS_SAVED_PAGE },
		control: { url: 'https://www.numisbids.com/sale/1', html: NUMISBIDS_SAVED_PAGE },
		accept: acceptParsed('lots'),
	},
	[`tool:${ACQ_NUMISDATA}:commit_lots`]: {
		refused: {
			auction: { auctionHouse: 'zzauthz house', auctionNumber: '1' },
			lots: [
				{
					lotNumber: '1',
					title: 'zzauthz',
					images: [{ sourceUrl: 'https://zzauthz.invalid/a.jpg' }],
				},
			],
		},
		control: { lots: ['zzauthz: not a lot'] },
		accept: acceptEmptyCommit('lots_total'),
	},
	[`tool:${ACQ_BIBLIOGRAPHY}:preview_url`]: {
		refused: { url: 'https://zzauthz.invalid/index.php/zz/oai' },
		control: { url: 'http://zzauthz.invalid/index.php/zz/oai' },
		accept: acceptCode('harvest.refused'),
	},
	[`tool:${ACQ_BIBLIOGRAPHY}:preview_html`]: {
		refused: { url: 'https://zzauthz.invalid/index.php/zz/oai', html: OAI_SAVED_PAGE },
		control: { url: 'https://zzauthz.invalid/index.php/zz/oai', html: OAI_SAVED_PAGE },
		accept: acceptParsed('publications'),
	},
	[`tool:${ACQ_BIBLIOGRAPHY}:commit_publications`]: {
		refused: {
			publications: [{ publicationIdentifier: 'oai:zzauthz:article/1', title: 'zzauthz' }],
		},
		control: { publications: ['zzauthz: not a publication'] },
		accept: acceptEmptyCommit('publications_total'),
	},
};

/** A spec's constant target list, read through its own extractor (the gate's input). */
function specTargets(spec: GatedToolActionSpec): { section_tipo: string; tipo?: string }[] {
	const targets = spec.targets?.({}) ?? [];
	if (targets.length === 0) throw new Error('acquisition spec names no targets');
	return targets as { section_tipo: string; tipo?: string }[];
}

/** The LAST component pair of a tool's commit list — what ACQ_PAIR_SHORT holds at 1. */
function shortPairOf(commit: GatedToolActionSpec): { section_tipo: string; tipo: string } {
	const pairs = specTargets(commit).filter((target) => target.tipo !== undefined);
	const last = pairs[pairs.length - 1];
	if (last === undefined) throw new Error('acquisition commit names no component pair');
	return last as { section_tipo: string; tipo: string };
}

/** Every acquisition spec, by tool — THROWS when a tool or its commit is not loaded. */
async function acquisitionSpecs(): Promise<Map<string, Record<string, GatedToolActionSpec>>> {
	const modules = await loadToolModules();
	const out = new Map<string, Record<string, GatedToolActionSpec>>();
	for (const [toolName, commit] of Object.entries(ACQ_COMMIT)) {
		const actions = modules.get(toolName)?.module.apiActions as
			| Record<string, GatedToolActionSpec>
			| undefined;
		if (actions?.[commit] === undefined) throw new Error(`${toolName}.${commit} is not loaded`);
		out.set(toolName, actions);
	}
	return out;
}

/** Each identity's dd774 grants, derived from the specs' own target lists. */
async function acquisitionGrants(): Promise<Record<AcqIdentity, [string, string, number][]>> {
	const grants: Record<AcqIdentity, Map<string, [string, string, number]>> = {
		ACQ_CONTROL: new Map(),
		ACQ_READ_ONLY: new Map(),
		ACQ_PAIR_SHORT: new Map(),
		ACQ_NO_SECTION: new Map(),
	};
	for (const [toolName, actions] of await acquisitionSpecs()) {
		const short = shortPairOf(actions[ACQ_COMMIT[toolName] as string] as GatedToolActionSpec);
		for (const spec of Object.values(actions)) {
			if (spec.permission !== 'targets') continue;
			for (const target of specTargets(spec)) {
				const tipo = target.tipo ?? target.section_tipo;
				const key = `${target.section_tipo}_${tipo}`;
				const isSection = target.tipo === undefined;
				const isShort = target.section_tipo === short.section_tipo && tipo === short.tipo;
				grants.ACQ_CONTROL.set(key, [target.section_tipo, tipo, 2]);
				grants.ACQ_READ_ONLY.set(key, [target.section_tipo, tipo, 1]);
				grants.ACQ_PAIR_SHORT.set(key, [target.section_tipo, tipo, isShort ? 1 : 2]);
				grants.ACQ_NO_SECTION.set(key, [target.section_tipo, tipo, isSection ? 0 : 2]);
			}
		}
	}
	return Object.fromEntries(
		Object.entries(grants).map(([identity, map]) => [identity, [...map.values()]]),
	) as Record<AcqIdentity, [string, string, number][]>;
}

async function insertAcqRow(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
) {
	const { encodeForJsonb } = await import('../../src/core/db/json_codec.ts');
	const { sql } = await import('../../src/core/db/postgres.ts');
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${params.length + 1}::text::jsonb`);
		params.push(encodeForJsonb(value));
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

/** Sweep the acquisition identities (tolerant before install, strict after). */
async function sweepAcquisitionIdentities(strict: boolean): Promise<void> {
	await assertTestDatabase('authz_door_matrix_native: acquisition identities sweep');
	const { deleteMatrixRecord } = await import('../../src/core/db/matrix_write.ts');
	const { sql } = await import('../../src/core/db/postgres.ts');
	const missing: string[] = [];
	for (const { userId } of Object.values(ACQ_IDENTITIES)) {
		for (const [table, sectionTipo, sectionId] of [
			['matrix_users', USERS, userId],
			['matrix_profiles', 'dd234', acqProfileOf(userId)],
		] as const) {
			if (sectionId < ACQ_BAND_LOW || sectionId > ACQ_BAND_HIGH) {
				throw new Error(
					`acquisition identity id ${sectionId} is outside ${ACQ_BAND_LOW}-${ACQ_BAND_HIGH}`,
				);
			}
			if ((await deleteMatrixRecord(table, sectionTipo, sectionId)) === 0) {
				missing.push(`${table}/${sectionId}`);
			}
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[sectionTipo, sectionId],
			);
		}
	}
	if (strict && missing.length > 0) {
		throw new Error(`acquisition identities sweep removed 0 rows for: ${missing.join(', ')}`);
	}
	clearAuthzDoorCaches();
}

const acqPrincipals = new Map<AcqIdentity, Principal>();

/** Mint the acquisition identities (dd234 profile + dd128 user each, project P). */
async function installAcquisitionIdentities(): Promise<void> {
	await assertTestDatabase('authz_door_matrix_native: acquisition identities');
	await sweepAcquisitionIdentities(false);
	const grants = await acquisitionGrants();
	const loc = (from: string, sectionTipo: string, sectionId: number) => ({
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: from,
	});
	for (const [identity, { userId }] of Object.entries(ACQ_IDENTITIES) as [
		AcqIdentity,
		{ userId: number },
	][]) {
		await insertAcqRow('matrix_profiles', 'dd234', acqProfileOf(userId), {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zzauthz ${identity} profile` }] },
			misc: {
				dd774: grants[identity].map(([section_tipo, tipo, value], index) => ({
					id: index + 1,
					tipo,
					section_tipo,
					value,
				})),
			},
		});
		await insertAcqRow('matrix_users', USERS, userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `zzauthz_${identity.toLowerCase()}` }] },
			relation: {
				dd131: [loc('dd131', 'dd64', 1)],
				dd244: [loc('dd244', 'dd64', 2)],
				dd515: [loc('dd515', 'dd64', 2)],
				dd1725: [loc('dd1725', 'dd234', acqProfileOf(userId))],
				dd170: [loc('dd170', 'dd153', AUTHZ_PROJECT_P)],
			},
		});
	}
	clearAuthzDoorCaches();
	for (const [identity, { userId }] of Object.entries(ACQ_IDENTITIES) as [
		AcqIdentity,
		{ userId: number },
	][]) {
		acqPrincipals.set(identity, await resolvePrincipal(userId));
	}
}

/**
 * THROWS unless every acquisition identity confers what its row claims, through
 * the REAL resolver — and the claims contrast (no zero-versus-zero column).
 */
async function assertAcquisitionContrast(): Promise<number> {
	const grants = await acquisitionGrants();
	const previewSections = new Set<string>();
	for (const actions of (await acquisitionSpecs()).values()) {
		for (const spec of Object.values(actions)) {
			if (spec.permission === 'targets' && (spec.minLevel ?? 2) < 2) {
				for (const target of specTargets(spec)) previewSections.add(target.section_tipo);
			}
		}
	}
	if (previewSections.size === 0) throw new Error('no acquisition preview names a target');
	let checked = 0;
	for (const identity of Object.keys(ACQ_IDENTITIES) as AcqIdentity[]) {
		const principal = acqPrincipals.get(identity) as Principal;
		if (principal.isGlobalAdmin || principal.isDeveloper) {
			throw new Error(`${identity} resolved as an admin/developer — the contrast is void`);
		}
		for (const [sectionTipo, tipo, level] of grants[identity]) {
			const grant = await getPermissionGrant(principal, sectionTipo, tipo);
			const resolved = grant.level;
			// The ONE tolerated difference: an explicit 0 on a section stored in a
			// public-list table answers READ by RULE (getPermissionGrant's list
			// fallback) — still below every commit's 2, and never a preview's own
			// target (asserted: a preview section must resolve the claimed 0).
			const publicListRead =
				level === 0 &&
				resolved === 1 &&
				grant.basis === 'rule' &&
				!previewSections.has(sectionTipo);
			if (resolved !== level && !publicListRead) {
				throw new Error(
					`${identity}: (${sectionTipo}, ${tipo}) resolves ${resolved}, claimed ${level}`,
				);
			}
			checked++;
		}
	}
	return checked;
}

/** Matrix + TM rows on the tool's target sections — the zero-write census of a cell. */
async function rowsOnTargets(sectionTipos: readonly string[]): Promise<number> {
	const { sql } = await import('../../src/core/db/postgres.ts');
	const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
	let total = 0;
	for (const sectionTipo of sectionTipos) {
		const table = await getMatrixTableFromTipo(sectionTipo).catch(() => null);
		if (table === null) continue;
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${table}" WHERE section_tipo = $1`,
			[sectionTipo],
		)) as { n: number }[];
		total += rows[0]?.n ?? 0;
	}
	const tm = (await sql.unsafe(
		"SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = ANY(string_to_array($1, ','))",
		[sectionTipos.join(',')],
	)) as { n: number }[];
	return total + (tm[0]?.n ?? 0);
}

/**
 * Run one cell with the network REFUSED (every fetch recorded and thrown) and
 * the target sections' row count pinned: either one moving THROWS — a cell
 * that reached a socket or wrote a row is a defect, never a verdict.
 */
async function guardedCell(
	key: string,
	sectionTipos: readonly string[],
	run: () => Promise<Outcome>,
): Promise<Outcome> {
	const before = await rowsOnTargets(sectionTipos);
	const original = globalThis.fetch;
	const reached: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		reached.push(input instanceof Request ? input.url : String(input));
		throw new Error('authz matrix: the acquisition cell reached the network');
	}) as unknown as typeof fetch;
	let outcome: Outcome | undefined;
	let failure: unknown;
	try {
		outcome = await run();
	} catch (error) {
		failure = error;
	} finally {
		globalThis.fetch = original;
	}
	if (reached.length > 0) throw new Error(`${key}: reached the network: ${reached.join(', ')}`);
	const after = await rowsOnTargets(sectionTipos);
	if (after !== before) throw new Error(`${key}: wrote ${after - before} row(s) on its targets`);
	if (failure !== undefined) throw failure;
	return outcome as Outcome;
}

function acquisitionProbe(
	key: string,
	toolName: string,
	action: string,
	spec: GatedToolActionSpec,
	commit: GatedToolActionSpec,
	acase: AcquisitionCase,
): Probe {
	const writes = (spec.minLevel ?? 2) >= 2;
	const short = shortPairOf(commit);
	const sectionTipos = [...new Set(specTargets(spec).map((target) => target.section_tipo))];
	const expectations: Partial<Record<IdentityKey, Verdict>> = {
		NO_SECTION: 'refused',
		READ_ONLY: writes ? 'refused' : 'served',
		READ_COMPONENT: writes ? 'refused' : 'served',
		CONTROL: 'served',
	};
	const identityOf = (column: IdentityKey): AcqIdentity => {
		const found = (Object.entries(ACQ_IDENTITIES) as [AcqIdentity, { column: IdentityKey }][]).find(
			([, row]) => row.column === column,
		);
		if (found === undefined) throw new Error(`${key}: no acquisition identity for ${column}`);
		return found[0];
	};
	return {
		expect: expectations,
		// The commit's pair half, isolated: refused ON the last pair (verified below).
		...(writes ? { refusalTipo: { READ_COMPONENT: short.tipo } } : {}),
		run: (column) =>
			guardedCell(`${key} × ${column}`, sectionTipos, async () => {
				const principal = acqPrincipals.get(identityOf(column)) as Principal;
				const served = expectations[column] === 'served';
				const options = served ? acase.control : acase.refused;
				const check = await assertActionPermission(spec as ToolActionSpec, options, principal);
				if (!check.ok) {
					const outcome = checkOutcome(check);
					if (column === 'READ_COMPONENT' && writes) {
						// PIN: drop the short pair and the same principal must be ADMITTED —
						// else the refusal came from another target and the cell is wrong.
						const without = await assertActionPermission(
							{
								...spec,
								targets: (o: Record<string, unknown>) =>
									(spec.targets?.(o) ?? []).filter(
										(t) => !(t.section_tipo === short.section_tipo && t.tipo === short.tipo),
									),
							} as ToolActionSpec,
							options,
							principal,
						);
						if (!without.ok) {
							return { ...outcome, code: `${outcome.code} (not on ${short.tipo})` };
						}
					}
					return outcome;
				}
				// A regressed refusal: report it, never run the dangerous payload.
				if (!served) return { verdict: 'served', detail: 'the gate admitted it (handler NOT run)' };
				let value: unknown;
				let error: unknown;
				try {
					value = await spec.handler({
						principal,
						userId: principal.userId,
						options: structuredClone(options),
						background: false,
					} as ToolActionContext);
				} catch (caught) {
					error = caught;
				}
				const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
				const objectSection = sectionTipos[0] as string;
				const ontologyPresent =
					(await getMatrixTableFromTipo(objectSection).catch(() => null)) !== null;
				acase.accept({ value, error, ontologyPresent });
				return {
					verdict: 'served',
					detail: `${toolName}.${action} past the gate (${error instanceof DedaloError ? error.code : 'ok'})`,
				};
			}),
	};
}

function mcpSearchProbe(run: (principal: Principal) => Promise<unknown>): Probe {
	return {
		expect: { NO_SECTION: 'refused', CONTROL: 'served' },
		run: (identity) => outcomeOf(() => run(principalOf(identity))),
	};
}

function mcpWriteProbe(
	run: (
		principal: Principal,
		target: { section_tipo: string; tipo: string; section_id: number },
	) => Promise<unknown>,
): Probe {
	return {
		// dd128's own-record DOWNGRADE already holds at the MCP doors (P1-2); the
		// leg stays so the delegation cannot lose it.
		expect: { ...FULL, DD1725: 'refused' },
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_TEXT);
			return outcomeOf(() => run(principalOf(identity), target));
		},
	};
}

function agentProbe(action: string, options: Record<string, unknown>): Probe {
	return {
		expect: { NO_TOOL: 'refused', CONTROL: 'served' },
		run: (identity) => {
			const principal = identity === 'CONTROL' ? ids.toolGranted : principalOf(identity);
			return outcomeOf(() =>
				dispatchRqo(
					{ action, dd_api: 'dd_mcp_api', options } as unknown as Rqo,
					dispatchContext(principal) as never,
				),
			);
		},
	};
}

// --- the census ------------------------------------------------------------------

const MEDIA_CLASSES = {
	dd_component_av_api: { actions: componentAvApiActions, model: 'component_av', tipo: AUTHZ_AV },
	dd_component_3d_api: { actions: component3dApiActions, model: 'component_3d', tipo: AUTHZ_3D },
} as const;

const TRANSCRIPTION_OPTIONS: Record<
	string,
	(t: ReturnType<typeof recordTarget>) => Record<string, unknown>
> = {
	create_transcribable_audio_file: (t) => ({
		media_ddo: { component_tipo: AUTHZ_AV, section_tipo: t.section_tipo, section_id: t.section_id },
	}),
	delete_transcribable_audio_file: (t) => ({
		media_ddo: { component_tipo: AUTHZ_AV, section_tipo: t.section_tipo, section_id: t.section_id },
	}),
	automatic_transcription: (t) => ({
		media_ddo: { component_tipo: AUTHZ_AV, section_tipo: t.section_tipo, section_id: t.section_id },
		transcription_ddo: {
			component_tipo: AUTHZ_TEXT_AREA,
			section_tipo: t.section_tipo,
			section_id: t.section_id,
		},
		source_lang: 'lg-eng',
		transcriber_quality: 'audio',
		transcriber_engine: 'babel_transcriber',
	}),
	check_server_transcriber_status: (t) => ({
		media_ddo: { component_tipo: AUTHZ_AV, section_tipo: t.section_tipo, section_id: t.section_id },
		transcriber_engine: 'babel_transcriber',
		pid: 123,
	}),
	build_subtitles_file: (t) => ({
		section_tipo: t.section_tipo,
		component_tipo: AUTHZ_TEXT_AREA,
		section_id: t.section_id,
		lang: 'lg-eng',
		max_charline: 40,
	}),
};

/** The transcript each transcription door AUTHORS (write level 2) — every other door only reads. */
const TRANSCRIPT_AUTHORED: Readonly<Record<string, string>> = {
	automatic_transcription: AUTHZ_TEXT_AREA,
	build_subtitles_file: AUTHZ_TEXT_AREA,
};

/**
 * EVERY `record`-kind tool action, classified by its EFFECT. The `record` kind
 * asks the section level and the record scope, NEVER the component — correct
 * only for a door whose effect is section-wide (or addresses no component of the
 * payload). A handler that writes or reads ONE component named by the payload
 * (`tipo` / `component_tipo`) must declare `record_tipo`: on the `record` kind a
 * profile explicitly denied that component acts on it through the section grant
 * (the WRITE-DOOR / SEC-2-media hole). A `record`-kind action missing here is
 * RED; a listed key that is no longer a `record`-kind action is RED (stale).
 * `component` entries are the OPEN holes — shrink-only through
 * {@link RECORD_KIND_COMPONENT_CEILING}, each with an OPEN canary below.
 */
const RECORD_KIND_EFFECT: Readonly<
	Record<string, { effect: 'section' | 'component'; reason: string }>
> = {
	'tool:tool_posterframe:get_ar_identifying_image': {
		effect: 'section',
		reason:
			"reads the records that REFERENCE the target record (inverse references, each hit scoped to the caller's projects) — no component of the payload is read or written",
	},
	'tool:tool_dev_template:write_demo': {
		effect: 'section',
		reason:
			"the exemplar's section-level demo: echoes the record coordinates and writes nothing (its component twin, component_write_demo, is record_tipo)",
	},
};

/** The pinned number of OPEN `component` entries above (lower it when one is re-declared record_tipo). */
const RECORD_KIND_COMPONENT_CEILING = 0;

/**
 * SHRINK-ONLY. A door the matrix does not probe YET, with the reason. An entry
 * that is no longer a derived door, or that has become probed, is RED (stale);
 * and the COUNT is pinned by {@link NOT_YET_PROBED_CEILING} — silencing a new
 * ungated door by adding a line here needs a second, visible edit.
 */
const NOT_YET_PROBED: Readonly<Record<string, string>> = {
	'dd_diffusion_api:diffuse':
		'diffusion subsystem door (Step 6) — not a record/component write door of this step',
	'dd_diffusion_api:cancel_process': 'diffusion subsystem door (Step 6)',
	'dd_diffusion_api:rebuild_media_index': 'diffusion subsystem door (Step 6)',
	'dd_diffusion_api:sweep_published_langs': 'diffusion subsystem door (Step 6)',
	'dd_diffusion_api:retry_pending_deletions': 'diffusion subsystem door (Step 6)',
	'dd_area_maintenance_api:lock_components_actions':
		'maintenance-area lock state — the dd88 admin gate, no record addressed',
	'dd_error_report_api:receive_report':
		'pre-authentication report intake — no record, no grant to test',
	'dd_ts_api:add_child': 'thesaurus tree write (Step 5 tree integrity owns the tree doors)',
	'dd_ts_api:update_parent_data': 'thesaurus tree write (Step 5)',
	'dd_ts_api:save_order': 'thesaurus tree write (Step 5)',
	'dd_utils_api:update_lock_components_state': 'session UI lock state — no record write',
	'dd_utils_api:stop_process': 'process control — the job owner check, not a record door',
	'dd_utils_api:change_lang': 'session language — no record',
	'dd_utils_api:delete_uploaded_file': "the caller's own upload staging — no record",
	'dd_utils_api:login': 'session lifecycle — pre-authentication',
	'dd_utils_api:request_password_reset': 'session lifecycle — pre-authentication',
	'dd_utils_api:confirm_password_reset': 'session lifecycle — pre-authentication',
	'dd_utils_api:quit': 'session lifecycle',
	'dd_utils_api:join_chunked_files_uploaded': "the caller's own upload staging — no record",
	'mcp:dedalo_portal_link': 'MCP portal link — needs a portal fixture on the scratch record',
	'tool:tool_dev_template:scoped_batch_demo':
		'targets kind: the extractor reads an action-specific payload shape',
	'tool:tool_hierarchy:generate_virtual_section':
		'targets kind: extractor-specific payload (hierarchy records)',
	'tool:tool_hierarchy:inspect_hierarchy':
		'targets kind: extractor-specific payload (hierarchy records)',
	'tool:tool_import_files:get_media_section_match':
		'targets kind: extractor-specific payload (import mapping)',
	'tool:tool_import_files:get_media_section_match_from_souce':
		'targets kind: extractor-specific payload (import mapping)',
	'tool:tool_import_files:import_files': 'targets kind: extractor-specific payload (import batch)',
	'tool:tool_import_marc21:import_files': 'targets kind: extractor-specific payload (import batch)',
	'tool:tool_import_zotero:import_files': 'targets kind: extractor-specific payload (import batch)',
	// section_list kind — the batch's section targets ride an action-specific payload.
	'tool:tool_dev_template:batch_demo': 'section_list kind: extractor-specific payload',
	'tool:tool_identify:cluster': 'section_list kind: extractor-specific payload (cluster scope)',
	'tool:tool_import_dedalo_csv:import_files':
		'section_list kind: extractor-specific payload (import batch)',
	'tool:tool_import_dedalo_csv:validate_import':
		'section_list kind: extractor-specific payload (import batch)',
	'tool:tool_import_rdf:get_rdf_data': 'section_list kind: extractor-specific payload (rdf import)',
	'tool:tool_update_cache:get_component_list':
		'section_list kind: extractor-specific payload (component list)',
	// permission: null — gated IN the handler (the named exemption; its
	// gatedInHandler prose is pinned by tool_permission_census_tripwire).
	'tool:tool_propagate_component_data:propagate_component_data':
		'OPEN record-WRITING batch door gated in-handler (raw getPermissions pair up front + per-row re-authorization) — not probed (tools/tool_propagate_component_data is outside lane 2)',
	'tool:tool_error_report:send_report': 'global-admin check in-handler — no record target',
	'tool:tool_dev_template:status': 'UNGATED constant literal — no record, no write',
	'tool:tool_import_dedalo_csv:get_csv_files':
		"the caller's own staging directory (importDir(ctx.userId)) — no record",
	'tool:tool_import_dedalo_csv:delete_csv_file':
		"the caller's own staging directory (importDir(ctx.userId)) — no record",
	'tool:tool_import_dedalo_csv:process_uploaded_file':
		"the caller's own staging directory (importDir(ctx.userId)) — no record",
	'tool:tool_media_versions:get_job_status': 'job-ownership rule (mayStreamJob) — no record door',
	'tool:tool_upload:get_job_status': 'job-ownership rule (mayStreamJob) — no record door',
	'tool:tool_transcription:get_model_sources': 'install configuration read — no record',
	'tool:tool_transcription:download_model': 'global-admin model store write — no record',
	'tool:tool_transcription:verify_model': 'global-admin model store read — no record',
	'tool:tool_transcription:repair_model': 'global-admin model store write — no record',
	'tool:tool_sitebuilder:get_status':
		'assertPublisher (developer/global admin) — daemon door, no record',
	'tool:tool_sitebuilder:list_sites': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:create_site': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:delete_site': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:session_start': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:session_message': 'assertPublisher + assertSessionOwner — no record',
	'tool:tool_sitebuilder:session_stop': 'assertPublisher + assertSessionOwner — no record',
	'tool:tool_sitebuilder:session_history': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:session_stream': 'assertPublisher + assertSessionOwner — no record',
	'tool:tool_sitebuilder:build': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:get_build': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:preview': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:publish': 'assertPublisher — daemon door, no record',
	'tool:tool_sitebuilder:get_audit': 'assertPublisher — daemon door, no record',
};

/**
 * The pinned size of NOT_YET_PROBED (lower it when a door becomes probed; never
 * raise it silently). Raised 31 → 65 VISIBLY in review r9, when the census became
 * total over the tool registry (every apiActions entry, not only the
 * record-addressed kinds): 28 in-handler `permission: null` doors and 6
 * `section_list` doors that were simply never counted. 65 → 64: SEC-2
 * `dd_component_portal_api:delete_locator` probed (the write door). 64 → 62:
 * req 10 — tool_lang / tool_lang_multi `automatic_translation` on the write door,
 * probed through the real handler (translationProbe). 62 → 61: req 10 —
 * tool_update_cache `update_cache`'s per-row write door (updateCacheRowProbe).
 * 61 → 60: `dd_utils_api:install` removed with the browser installer
 * (WC-2026-10-12-install-surface-removed) — not probed, gone.
 */
const NOT_YET_PROBED_CEILING = 60;

interface Census {
	probes: Map<string, Probe>;
	delegated: Set<string>;
	derived: Set<string>;
	/** Every loaded `record`-kind tool action (RECORD_KIND_EFFECT must classify each). */
	recordKind: Set<string>;
}

async function deriveCensus(): Promise<Census> {
	const probes = new Map<string, Probe>();
	const delegated = new Set<string>();
	const derived = new Set<string>();
	const recordKind = new Set<string>();

	// 1. READ_DOOR_POSTURE — mutating + component rows, and every media row.
	for (const [key, posture] of READ_DOOR_POSTURE) {
		const [api, action] = key.split(':') as [string, string];
		const media = MEDIA_CLASSES[api as keyof typeof MEDIA_CLASSES];
		if (media !== undefined) {
			derived.add(key);
			const handler = media.actions[action];
			if (handler === undefined) throw new Error(`posture row ${key} names no handler`);
			probes.set(
				key,
				mediaProbe(
					handler,
					action,
					media.model,
					media.tipo,
					posture.posture === 'mutating' ? 2 : 1,
				),
			);
			continue;
		}
		if (posture.posture === 'mutating') derived.add(key);
		if (posture.posture === 'component') {
			derived.add(key);
			// DELEGATED only on EVIDENCE, never on the label: the row names the read
			// door gate AND read_door_acl_native registers a leg for it that runs to
			// completion (test/helpers/read_door_probes.ts — its own last test
			// asserts the completed set equals READ_DOOR_PROBED).
			if (posture.gate === READ_DOOR_GATE && READ_DOOR_PROBED.has(key)) delegated.add(key);
		}
	}

	// 2. tool apiActions — EVERY action of every loaded tool is a derived door,
	// whatever its kind (an in-handler `permission: null` door that writes a
	// record is exactly what a kind-filtered walk would miss). The declarative
	// kinds the matrix can drive generically are probed; transcription's
	// in-handler doors are probed through TRANSCRIPTION_OPTIONS; everything else
	// must be in NOT_YET_PROBED with its reason, or the totality test is RED.
	const transcriptionActions = new Set<string>();
	for (const [toolName, loaded] of await loadToolModules()) {
		for (const [action, spec] of Object.entries(loaded.module.apiActions)) {
			const key = `tool:${toolName}:${action}`;
			derived.add(key);
			if (toolName === 'tool_transcription') transcriptionActions.add(action);
			if (
				spec.permission === 'record' ||
				spec.permission === 'record_tipo' ||
				spec.permission === 'tipo'
			) {
				if (spec.permission === 'record') recordKind.add(key);
				probes.set(key, toolKindProbe(spec, key));
			} else if (spec.permission === 'section') {
				probes.set(key, sectionKindProbe(spec));
			} else if (spec.permission === 'developer') {
				probes.set(key, developerKindProbe(spec));
			} else if (
				(toolName === 'tool_lang' || toolName === 'tool_lang_multi') &&
				action === 'automatic_translation'
			) {
				probes.set(key, translationProbe(spec.handler));
			} else if (toolName === 'tool_update_cache' && action === 'update_cache') {
				probes.set(key, updateCacheRowProbe(spec.handler));
			} else if (toolName === 'tool_transcription' && TRANSCRIPTION_OPTIONS[action] !== undefined) {
				probes.set(
					key,
					transcriptionProbe(
						spec.handler,
						TRANSCRIPTION_OPTIONS[action],
						action === 'automatic_transcription',
						TRANSCRIPT_AUTHORED[action],
						action === 'create_transcribable_audio_file' ||
							action === 'delete_transcribable_audio_file',
					),
				);
			}
		}
	}
	// The acquisition tools' fixed-target doors (PR #114) — probed with their own
	// identities (acquisitionProbe). No stale case: every ACQUISITION_CASES key is a
	// live `targets` action.
	const acquisition = await acquisitionSpecs();
	for (const key of Object.keys(ACQUISITION_CASES)) {
		const [, toolName, action] = key.split(':') as [string, string, string];
		const actions = acquisition.get(toolName);
		const spec = actions?.[action];
		if (spec === undefined || spec.permission !== 'targets') {
			throw new Error(`ACQUISITION_CASES names no live 'targets' action: ${key}`);
		}
		probes.set(
			key,
			acquisitionProbe(
				key,
				toolName,
				action,
				spec,
				actions?.[ACQ_COMMIT[toolName] as string] as GatedToolActionSpec,
				ACQUISITION_CASES[key] as AcquisitionCase,
			),
		);
	}
	// The posterframe HOST door — an in-handler write door behind the AV gate,
	// probed under its own key (it is not a separate action: the declarative
	// probe above keeps the action's own key).
	const posterframe = (await loadToolModules()).get('tool_posterframe');
	const createIdentifying = posterframe?.module.apiActions.create_identifying_image;
	if (createIdentifying === undefined) {
		throw new Error('tool_posterframe.create_identifying_image is not loaded');
	}
	probes.set(
		'tool:tool_posterframe:create_identifying_image:host',
		posterframeHostProbe(createIdentifying.handler),
	);
	// The ingest companions' engine (req 10) — the writer every ingest door shares.
	probes.set('engine:media_ingest.companion_writes', companionProbe());
	// The mapped-record importer's engine (req 10) — MARC21 / Zotero / RDF write through it.
	probes.set('engine:import_execute.importMappedRecords', importExecuteProbe());
	// The CSV importer's engine (req 10) — tool_import_dedalo_csv writes through it.
	probes.set('engine:import_csv_execute.executeCsvImport', csvImportProbe());
	// tool_import_rdf's ontology-driven executor — the caller record and every
	// term bound at run time through the write door as the importer.
	probes.set('tool:tool_import_rdf:rdf_import_execute', rdfImportProbe());
	// tool_import_files' run-time role writes (req 10).
	probes.set('tool:tool_import_files:import_files:roles', importFilesRoleProbe());
	// The bulk revert's per-component writer door (req 10).
	probes.set('tool:tool_time_machine:bulk_revert_process:units', bulkRevertProbe());
	// apply_value's whole-record restore: its per-changed-component door (cross-write:r3).
	probes.set('tool:tool_time_machine:apply_value:section', tmSectionApplyProbe());
	// No stale probe: every TRANSCRIPTION_OPTIONS key is a live tool_transcription action.
	const staleTranscription = Object.keys(TRANSCRIPTION_OPTIONS).filter(
		(action) => !transcriptionActions.has(action),
	);
	if (staleTranscription.length > 0) {
		throw new Error(
			`TRANSCRIPTION_OPTIONS names no tool_transcription action: ${staleTranscription.join(', ')}`,
		);
	}

	// 3. MCP TOOL_REGISTRY — search / count + every write tool.
	for (const spec of TOOL_REGISTRY) {
		const key = `mcp:${spec.name}`;
		if (spec.write === true || /^dedalo_(search|count)_/.test(spec.name)) derived.add(key);
	}
	probes.set(
		'mcp:dedalo_search_section',
		mcpSearchProbe((p) => searchSectionRecords(p, { section_tipo: AUTHZ_SECTION })),
	);
	probes.set(
		'mcp:dedalo_search_records',
		mcpSearchProbe((p) => searchRecords(p, { section_tipo: AUTHZ_SECTION })),
	);
	probes.set(
		'mcp:dedalo_count_records',
		mcpSearchProbe((p) => countRecords(p, { section_tipo: AUTHZ_SECTION })),
	);
	probes.set(
		'mcp:dedalo_set_field',
		mcpWriteProbe((p, t) =>
			setField(p, {
				section_tipo: t.section_tipo,
				section_id: t.section_id,
				field: t.tipo,
				// dd1725 is a RELATION field: its value is a locator — the manager's
				// OWN profile, already assigned — so a door that let the DD1725 leg
				// through would WRITE (served), never trip a value-grammar refusal.
				value:
					t.tipo === 'dd1725'
						? { section_tipo: 'dd234', section_id: AUTHZ_USER_MANAGER_PROFILE_ID }
						: MATRIX_TEXT,
				lang: 'lg-eng',
				mode: 'replace',
			}),
		),
	);
	// portal_unlink — the file's SECOND dd128-reachable writer (it authorizes
	// itself, then calls deletePortalLocator; it does not go through setField).
	// DD1725 aims it at the manager's OWN dd1725 locator (its own profile): the
	// write door's own-record downgrade must refuse it before the locator is
	// looked up. Every other refused identity is refused by the door before any
	// lookup; the CONTROL is served PAST the door (the literal field holds no
	// such locator: resource.not_found — nothing is unlinked).
	probes.set(
		'mcp:dedalo_portal_unlink',
		mcpWriteProbe((p, t) =>
			portalUnlink(p, {
				section_tipo: t.section_tipo,
				section_id: t.section_id,
				field: t.tipo,
				target:
					t.tipo === 'dd1725'
						? { section_tipo: 'dd234', section_id: AUTHZ_USER_MANAGER_PROFILE_ID }
						: { section_tipo: AUTHZ_SECTION, section_id: recordId },
			}),
		),
	);
	probes.set(
		'mcp:dedalo_save_component',
		mcpWriteProbe((p, t) =>
			saveComponentValue(p, {
				section_tipo: t.section_tipo,
				tipo: t.tipo,
				section_id: t.section_id,
				lang: 'lg-eng',
				action: 'update',
				value: { id: 1, lang: 'lg-eng', value: MATRIX_TEXT },
			}),
		),
	);

	// The MCP record-lifecycle + media doors (closure Step 3: authorizeSectionTarget
	// / authorizeRecordAccess). Every identity that could DESTROY or MINT acts on
	// a DISPOSABLE record, and every id a probe mints is swept — a regressed door
	// must never take the shared record, or leave a row behind.
	const mcpSection = (identity: IdentityKey) =>
		identity === 'ADMIN_CAPPED' ? CONSULTATION_ONLY : AUTHZ_SECTION;
	// A section-level shortfall names the SECTION itself: the cap refuses ON
	// dd542, the read-only level ON test3 — never a grammar or a search refusal.
	const SECTION_LEVEL_PINS: Partial<Record<IdentityKey, string>> = {
		READ_ONLY: AUTHZ_SECTION,
		ADMIN_CAPPED: CONSULTATION_ONLY,
	};
	probes.set('mcp:dedalo_create_record', {
		refusalTipo: SECTION_LEVEL_PINS,
		// A create names no record: NO_SECTION / READ_ONLY are short on the section
		// level; the superuser is refused only by the consultation cap.
		expect: {
			NO_SECTION: 'refused',
			READ_ONLY: 'refused',
			ADMIN_CAPPED: 'refused',
			CONTROL: 'served',
		},
		run: (identity) =>
			outcomeOf(async () => {
				const created = await createRecord(principalOf(identity), {
					section_tipo: mcpSection(identity),
				});
				disposable.push({ sectionTipo: mcpSection(identity), sectionId: created.section_id });
				return created;
			}),
	});
	const lifecycleRecord = async (identity: IdentityKey) =>
		identity === 'ADMIN_ID0'
			? { section_tipo: AUTHZ_SECTION, section_id: -1 }
			: { section_tipo: AUTHZ_SECTION, section_id: await disposableRecord() };
	const LIFECYCLE: Partial<Record<IdentityKey, Verdict>> = {
		NO_SECTION: 'refused',
		READ_ONLY: 'refused',
		OUT_OF_SCOPE: 'refused',
		ADMIN_ID0: 'refused',
		CONTROL: 'served',
	};
	probes.set('mcp:dedalo_delete_record', {
		expect: LIFECYCLE,
		run: async (identity) => {
			const target = await lifecycleRecord(identity);
			return outcomeOf(() => deleteRecord(principalOf(identity), target));
		},
	});
	probes.set('mcp:dedalo_duplicate_record', {
		expect: LIFECYCLE,
		run: async (identity) => {
			const target = await lifecycleRecord(identity);
			return outcomeOf(async () => {
				const copy = await duplicateRecord(principalOf(identity), target);
				disposable.push({ sectionTipo: copy.section_tipo, sectionId: copy.section_id });
				return copy;
			});
		},
	});
	probes.set('mcp:dedalo_upload_media', {
		// The write door on (section, media component, record). CONTROL is served
		// PAST the door: its source is a path the deployment refuses
		// (mcp.media_path_disabled / resource.not_found) — nothing is staged.
		expect: { ...FULL, DD1725: 'refused' },
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_AV);
			return outcomeOf(() =>
				uploadMedia(principalOf(identity), {
					section_tipo: target.section_tipo,
					section_id: target.section_id,
					field: target.tipo,
					source: { kind: 'path', path: '/zzauthz/no/such/file.mp4' },
				}),
			);
		},
	});
	// find_or_create — the SEARCH half (NO_SECTION: the section read grant) and
	// the CREATE half: a match nobody holds forces the create branch, where
	// READ_ONLY (may search, may not create) and the capped superuser are refused.
	// CONTROL completes a create: the SUPERUSER, because a test3 record is born
	// with no project (record_defaults' FILTER_EXCLUDED_SECTIONS) and the fill
	// step after the create is then out of any non-admin's scope.
	// NO_COMPONENT (the section at 2, the match field at 0): refused BEFORE the
	// create, ON the match field — the field pre-flight (review r8); the record
	// count + sequence half is mcp_record_door_native.
	probes.set('mcp:dedalo_find_or_create', {
		refusalTipo: { ...SECTION_LEVEL_PINS, NO_COMPONENT: AUTHZ_TEXT },
		expect: {
			NO_SECTION: 'refused',
			NO_COMPONENT: 'refused',
			READ_ONLY: 'refused',
			ADMIN_CAPPED: 'refused',
			CONTROL: 'served',
		},
		run: (identity) =>
			outcomeOf(async () => {
				const found = await findOrCreate(
					identity === 'CONTROL' ? superuser : principalOf(identity),
					{
						section_tipo: mcpSection(identity),
						match: [
							{
								field: identity === 'ADMIN_CAPPED' ? 'dd544' : AUTHZ_TEXT,
								value: `zzauthz foc ${crypto.randomUUID()}`,
								lang: 'lg-eng',
							},
						],
					},
				);
				if (found.created)
					disposable.push({ sectionTipo: found.section_tipo, sectionId: found.section_id });
				return found;
			}),
	});

	// 4. the agent door.
	for (const action of Object.keys(mcpApiActions)) {
		const key = `dd_mcp_api:${action}`;
		derived.add(key);
		probes.set(
			key,
			agentProbe(
				action,
				action === 'mcp_proxy'
					? { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
					: action.startsWith('agent_chat')
						? { question: 'zzauthz matrix', model: AUTHZ_STUB_MODEL_ID }
						: action === 'agent_apply'
							? { plan: { ops: [] }, plan_hash: 'zzauthz-not-a-hash' }
							: {},
			),
		);
	}

	// 5. the human doors this step delegates.
	probes.set('dd_core_api:save', {
		// save's section floor is 0 — the NAMED exception (PHP component_common::save
		// parity + subdatum inline editing): NO_SECTION is SERVED there, by design.
		expect: {
			NO_SECTION: 'served',
			NO_COMPONENT: 'refused',
			OUT_OF_SCOPE: 'refused',
			DD1725: 'refused',
			ADMIN_ID0: 'refused',
			CONTROL: 'served',
		},
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_TEXT);
			const rqo = {
				action: 'save',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					type: 'component',
					tipo: target.tipo,
					section_tipo: target.section_tipo,
					section_id: String(target.section_id),
					mode: 'edit',
					lang: 'lg-eng',
				},
				data: {
					section_id: String(target.section_id),
					section_tipo: target.section_tipo,
					tipo: target.tipo,
					lang: 'lg-eng',
					changed_data: [
						{ action: 'update', id: null, value: { lang: 'lg-eng', value: MATRIX_TEXT } },
					],
				},
			} as unknown as Rqo;
			return outcomeOf(() => dispatchRqo(rqo, dispatchContext(principalOf(identity)) as never));
		},
	});
	probes.set('dd_utils_api:get_record_info', {
		// The inspector's Information panel: a whole-RECORD read, gated by the
		// section grant AND the record's project scope. The component level is
		// not its question — an unreadable audit half is masked inside the
		// answer, never a door refusal — and the non-positive id (ADMIN_ID0) is
		// refused by the record-ref grammar before any read.
		expect: {
			NO_SECTION: 'refused',
			OUT_OF_SCOPE: 'refused',
			ADMIN_ID0: 'refused',
			CONTROL: 'served',
		},
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_TEXT);
			const rqo = {
				action: 'get_record_info',
				dd_api: 'dd_utils_api',
				options: { section_tipo: target.section_tipo, section_id: target.section_id },
			} as unknown as Rqo;
			return outcomeOf(() => dispatchRqo(rqo, dispatchContext(principalOf(identity)) as never));
		},
	});
	// The record-lifecycle doors delegated to authorizeSectionTarget (closure Step
	// 3): the SECTION level (consultation-capped) + the record scope with the
	// non-positive-id refusal ahead of the admin bypass. A whole-record door: the
	// component is not its question (no NO_COMPONENT column). EVERY identity that
	// could destroy or mint acts on its OWN disposable record (swept after) — a
	// regressed door must never consume the shared record, or it would bury the
	// real red cell under the cascade of every later door's CONTROL.
	const lifecycleTarget = async (identity: IdentityKey) =>
		identity === 'ADMIN_ID0'
			? { section_tipo: AUTHZ_SECTION, section_id: -1 }
			: { section_tipo: AUTHZ_SECTION, section_id: await disposableRecord() };
	probes.set('dd_core_api:duplicate', {
		expect: {
			NO_SECTION: 'refused',
			OUT_OF_SCOPE: 'refused',
			ADMIN_ID0: 'refused',
			CONTROL: 'served',
		},
		run: (identity) =>
			outcomeOf(async () => {
				const result = await dispatchRqo(
					{
						action: 'duplicate',
						dd_api: 'dd_core_api',
						source: { ...(await lifecycleTarget(identity)), model: 'section' },
					} as unknown as Rqo,
					dispatchContext(principalOf(identity)) as never,
				);
				const newId = Number((result.body as { data?: unknown }).data);
				if (result.status === 200 && Number.isInteger(newId) && newId > 0) {
					disposable.push({ sectionTipo: AUTHZ_SECTION, sectionId: newId });
				}
				return result;
			}),
	});
	probes.set('dd_core_api:delete', {
		expect: {
			NO_SECTION: 'refused',
			OUT_OF_SCOPE: 'refused',
			ADMIN_ID0: 'refused',
			CONTROL: 'served',
		},
		run: (identity) =>
			outcomeOf(async () => {
				const target = await lifecycleTarget(identity);
				return dispatchRqo(
					{
						action: 'delete',
						dd_api: 'dd_core_api',
						source: { ...target, delete_mode: 'delete_record', model: 'section' },
					} as unknown as Rqo,
					dispatchContext(principalOf(identity)) as never,
				);
			}),
	});

	probes.set('dd_core_api:create', {
		refusalTipo: SECTION_LEVEL_PINS,
		expect: {
			NO_SECTION: 'refused',
			READ_ONLY: 'refused',
			ADMIN_CAPPED: 'refused',
			CONTROL: 'served',
		},
		run: (identity) =>
			outcomeOf(async () => {
				const sectionTipo = mcpSection(identity);
				const result = await dispatchRqo(
					{
						action: 'create',
						dd_api: 'dd_core_api',
						source: { section_tipo: sectionTipo, model: 'section' },
					} as unknown as Rqo,
					dispatchContext(principalOf(identity)) as never,
				);
				const newId = Number((result.body as { data?: unknown }).data);
				if (result.status === 200 && Number.isInteger(newId) && newId > 0) {
					disposable.push({ sectionTipo, sectionId: newId });
				}
				return result;
			}),
	});
	// THE SQO MULTI-DELETE (a global-admin operation): the section target is
	// consultation-capped like every section-level write — a global admin's SQO
	// over Activity is refused (ADMIN_CAPPED), a non-admin's over test3 too
	// (NO_SECTION: the level; READ_ONLY: the level); the CONTROL is the superuser's
	// SQO pinned to ONE disposable record (filter_by_locators), and the pin is
	// VERIFIED to match exactly that record before anything is sent.
	probes.set('dd_core_api:delete#sqo', {
		refusalTipo: SECTION_LEVEL_PINS,
		expect: {
			NO_SECTION: 'refused',
			READ_ONLY: 'refused',
			ADMIN_CAPPED: 'refused',
			CONTROL: 'served',
		},
		run: (identity) =>
			outcomeOf(async () => {
				const sectionTipo = mcpSection(identity);
				// ADMIN_CAPPED pins an id no Activity row holds: the SQO selects NOTHING,
				// so only the door's cap can refuse it (the delete engine's own backstop
				// never runs on zero targets) — the door itself is what this cell measures.
				const pinned = identity === 'ADMIN_CAPPED' ? 2_000_000_001 : await disposableRecord();
				const sqo = {
					section_tipo: [sectionTipo],
					filter_by_locators: [{ section_tipo: sectionTipo, section_id: pinned }],
					limit: 1,
				};
				await assertSqoPinsAtMostOne(sqo, sectionTipo, pinned);
				return dispatchRqo(
					{
						action: 'delete',
						dd_api: 'dd_core_api',
						source: { section_tipo: sectionTipo, delete_mode: 'delete_record', model: 'section' },
						sqo,
					} as unknown as Rqo,
					dispatchContext(identity === 'CONTROL' ? superuser : principalOf(identity)) as never,
				);
			}),
	});

	const deleteTag = componentTextAreaApiActions.delete_tag;
	if (deleteTag === undefined)
		throw new Error('dd_component_text_area_api:delete_tag is not registered');
	probes.set('dd_component_text_area_api:delete_tag', {
		// DD1725: the tag delete aimed at the manager's OWN (dd128, dd1725) — the
		// write door's own-record downgrade refuses it. NO_SECTION is SERVED: the
		// tag delete is the save door's twin (the same inline-edit write on the
		// same component) and carries its named floor-0 exception (review r8).
		expect: { ...FULL, NO_SECTION: 'served', DD1725: 'refused' },
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_TEXT_AREA);
			const rqo = {
				action: 'delete_tag',
				source: {
					tipo: target.tipo,
					section_tipo: target.section_tipo,
					section_id: target.section_id,
				},
				options: { tag_id: '5', type: 'index' },
			} as unknown as Rqo;
			return outcomeOf(() => deleteTag(rqo, handlerContext(principalOf(identity))));
		},
	});

	// SEC-2: the portal unlink goes through THE WRITE DOOR (write, level 2,
	// section floor 2): the pair (dd128-aware) and the record scope, ahead of any
	// read, lock or write. Driven through the HANDLER, which has no gate of its
	// own — every refusal below is the engine's. The locator matches nothing
	// (dd153/0, a tag never stored), so a REGRESSED engine still changes no
	// record: neither the shared one nor the manager's own dd1725. The section
	// floor is NOT claimed here — READ_SECTION holds test101 at 1 too, so both
	// halves refuse that cell with the same code; the floor is measured by
	// portal_locator_door_native leg g.
	const deleteLocator = componentPortalApiActions.delete_locator;
	if (deleteLocator === undefined)
		throw new Error('dd_component_portal_api:delete_locator is not registered');
	probes.set('dd_component_portal_api:delete_locator', {
		expect: { ...FULL, DD1725: 'refused', READ_SECTION: 'refused', READ_COMPONENT: 'refused' },
		refusalTipo: { NO_COMPONENT: AUTHZ_FILTER, READ_COMPONENT: AUTHZ_FILTER },
		run: (identity) => {
			const target = recordTarget(identity, AUTHZ_FILTER);
			const rqo = {
				action: 'delete_locator',
				source: {
					tipo: target.tipo,
					section_tipo: target.section_tipo,
					section_id: target.section_id,
				},
				options: {
					locator: { section_tipo: 'dd153', section_id: 0, tag_id: 'zzauthz-never-stored' },
					ar_properties: ['section_tipo', 'section_id', 'tag_id'],
				},
			} as unknown as Rqo;
			return outcomeOf(() => deleteLocator(rqo, handlerContext(principalOf(identity))));
		},
	});

	if (derived.size === 0 || probes.size === 0) {
		throw new Error('authz door matrix derived ZERO doors — the registry walk is broken');
	}
	return { probes, delegated, derived, recordKind };
}

describe.if(DB_READY)('Step 3 — the authorization-door matrix', () => {
	let census: Census;
	let provider: ReturnType<typeof Bun.serve> | null = null;
	/**
	 * True only once installAcquisitionIdentities RETURNED. A beforeAll that failed
	 * before or partway through the install leaves some identities absent, so the
	 * teardown sweep is strict (every row must be there) only when this is set —
	 * a strict throw there would mask the real beforeAll failure.
	 */
	let acquisitionInstalled = false;
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		'DEDALO_AGENT_HTTP_ENABLED',
		'DEDALO_AGENT_ALLOW_WRITE',
		'DEDALO_AGENT_MODELS',
		'ANTHROPIC_API_KEY',
	];

	beforeAll(async () => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		// The agent door's model endpoint is a local stand-in: no probe may reach
		// a real provider.
		provider = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			fetch: () =>
				Response.json({
					choices: [
						{ index: 0, message: { role: 'assistant', content: 'zzauthz' }, finish_reason: 'stop' },
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
		});
		process.env.DEDALO_AGENT_HTTP_ENABLED = 'true';
		delete process.env.DEDALO_AGENT_ALLOW_WRITE;
		delete process.env.ANTHROPIC_API_KEY;
		process.env.DEDALO_AGENT_MODELS = authzStubAgentModels(provider.port);
		await installAuthzDoorFixture();
		await ensureSituation(COMPANION_SITUATION);
		recordId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P, [
			{ tipo: AUTHZ_TEXT, lang: 'lg-eng', value: [{ id: 1, lang: 'lg-eng', value: MATRIX_TEXT }] },
		]);
		ids = await resolveAuthzIdentities();
		superuser = await resolvePrincipal(-1);
		await installAcquisitionIdentities();
		acquisitionInstalled = true;
		census = await deriveCensus();
	});

	afterAll(async () => {
		// The shared teardown (authz fixture + companion situation) runs in a
		// `finally`: a throw from any sweep above it must not leak the fixture.
		try {
			await sweepDisposable();
			provider?.stop(true);
			for (const key of ENV_KEYS) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
			await sweepAcquisitionIdentities(acquisitionInstalled);
		} finally {
			try {
				await removeAuthzDoorFixture();
			} finally {
				expect(await dropSituation(COMPANION_SITUATION)).toBe(0);
			}
		}
	});

	test('the contrast is live (guards every cell)', async () => {
		await assertAuthzDoorContrast(ids);
	});

	test('the acquisition contrast is live: every derived grant resolves as claimed (guards the acquisition cells)', async () => {
		// FLOOR: 4 identities over both tools' derived target lists.
		expect(await assertAcquisitionContrast()).toBeGreaterThan(4 * 20);
	});

	test('the census is TOTAL: every derived door is probed, delegated, or NOT_YET_PROBED', () => {
		// FLOOR: the walk really read the registries (posture rows, tools, MCP, agent).
		expect(census.derived.size).toBeGreaterThan(60);
		expect(census.probes.size).toBeGreaterThan(40);
		const unclassified = [...census.derived].filter(
			(key) =>
				!census.probes.has(key) && !census.delegated.has(key) && NOT_YET_PROBED[key] === undefined,
		);
		expect(unclassified).toEqual([]);
	});

	test('READ_DOOR_PROBED names only rows that CLAIM the proof: posture `component` gated by READ_DOOR_GATE, or a `mutating` row whose search half is probed (a downgraded row cannot under-claim a proven door)', () => {
		expect(READ_DOOR_PROBED.size).toBeGreaterThan(0);
		for (const key of READ_DOOR_PROBED) {
			const posture = READ_DOOR_POSTURE.get(key);
			const claims =
				posture?.posture === 'mutating' ||
				(posture?.posture === 'component' &&
					(posture as { gate?: string }).gate === READ_DOOR_GATE);
			expect({ key, posture: posture?.posture, claims }).toMatchObject({
				key,
				claims: true,
			});
			// …and the matrix classifies it as covered: DELEGATED (a component row the
			// matrix does not drive itself) or PROBED here (the media rows).
			expect({ key, covered: census.delegated.has(key) || census.probes.has(key) }).toEqual({
				key,
				covered: true,
			});
		}
	});

	test('RECORD_KIND_EFFECT is TOTAL over the `record`-kind tool actions, with no stale key', () => {
		expect(census.recordKind.size).toBeGreaterThan(0);
		expect([...census.recordKind].sort()).toEqual(Object.keys(RECORD_KIND_EFFECT).sort());
	});

	test('RECORD_KIND_EFFECT: the OPEN component-effect `record` doors are shrink-only (pinned count)', () => {
		const open = Object.entries(RECORD_KIND_EFFECT).filter(([, row]) => row.effect === 'component');
		expect(open.length).toBe(RECORD_KIND_COMPONENT_CEILING);
	});

	test('OPEN canary: every component-effect `record` door STILL lets NO_COMPONENT through (red once fixed — then drop its row and lower the ceiling)', async () => {
		for (const [key, row] of Object.entries(RECORD_KIND_EFFECT)) {
			if (row.effect !== 'component') continue;
			const probe = census.probes.get(key);
			if (probe === undefined) throw new Error(`${key} is not probed`);
			// The hole, measured: the section-only gate serves a caller holding the
			// component at an explicit 0. A fix (record_tipo) refuses it here.
			expect({ key, noComponent: (await probe.run('NO_COMPONENT')).verdict }).toEqual({
				key,
				noComponent: 'served',
			});
		}
	});

	test('NOT_YET_PROBED is shrink-only: no stale entry (every key a derived, unprobed door)', () => {
		const stale = Object.keys(NOT_YET_PROBED).filter(
			(key) => !census.derived.has(key) || census.probes.has(key),
		);
		expect(stale).toEqual([]);
	});

	test('NOT_YET_PROBED is shrink-only: its size is the pinned ceiling (growth needs a second, visible edit)', () => {
		expect(Object.keys(NOT_YET_PROBED).length).toBe(NOT_YET_PROBED_CEILING);
	});

	test('DD128_PROBED: every door a census `delegates` row stands on is probed here, with a refused DD1725 leg', () => {
		const files = Object.keys(DD128_PROBED);
		expect(files.length).toBeGreaterThan(0);
		for (const [file, doors] of Object.entries(DD128_PROBED)) {
			expect(doors.length, `${file} names no door`).toBeGreaterThan(0);
			for (const door of doors) {
				expect({ file, door, probed: census.probes.has(door) }).toEqual({
					file,
					door,
					probed: true,
				});
				expect({ file, door, dd1725: census.probes.get(door)?.expect.DD1725 }).toEqual({
					file,
					door,
					dd1725: 'refused',
				});
			}
		}
	});

	test('every probe has the CONTROL column (anti-vacuity) and at least one refusal column', () => {
		for (const [key, probe] of census.probes) {
			expect({ key, control: probe.expect.CONTROL }).toEqual({ key, control: 'served' });
			expect(Object.values(probe.expect).includes('refused')).toBe(true);
		}
	});

	test('the matrix: every probed door answers every identity as the design says', async () => {
		const wrong: string[] = [];
		let cells = 0;
		for (const [key, probe] of [...census.probes.entries()].sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			for (const [identity, expected] of Object.entries(probe.expect) as [IdentityKey, Verdict][]) {
				cells++;
				const outcome = await probe.run(identity);
				const mismatch = cellMismatch(probe, identity, expected, outcome);
				if (mismatch !== null) wrong.push(`${key} × ${identity}: ${mismatch} (${outcome.detail})`);
			}
		}
		// FLOOR: the matrix really ran (a probe table that emptied would pass `wrong`).
		expect(cells).toBeGreaterThan(150);
		expect(wrong).toEqual([]);
	});
});
