/**
 * THE TIME MACHINE NOTES OWN LEVEL — T0-4 part C (owner decisions 2 +
 * 3 and Q-a…Q-d, 2026-11-10; rewrite plan §3.2, §3.4, §4 cases 5-15).
 *
 * A note (the engine's TM-notes section: a text, a Code = the matrix_time_machine row it
 * annotates, creator = its dd200) is reached two ways, under two authorities:
 *
 *   AUDIT path — a PROFILE grant on the notes section (basis 'profile', level > 0): the
 *     notes section is an ordinary section, the matrix decides, and the edits
 *     are recorded in the notes section's own Time Machine.
 *   TM path — everyone else, ROOT AND GLOBAL ADMINS INCLUDED (the 'superuser'
 *     and 'rule' bases are no specific grant): access to the note FOLLOWS access
 *     to the change it annotates. Bound to a TM row whose section the caller has
 *     TM access to → the creator 2 on the text, everyone else 1; the Code is 1
 *     for everyone (only the server writes it, create_tm_note); no TM access → 0;
 *     a note with no Code is no note → 0; a creator who lost TM access → 0.
 *   level = max(profile, TM path); a node stamp (no record) = max(profile, 0).
 *   The creator deletes their own note on the TM path; others at section level.
 *
 * Before (HEAD): the notes section followed the matrix alone — and it lives in a
 * PUBLIC-LIST table (matrix_notes), so the 'rule' fallback gave EVERY user read
 * on every note's text, the creator could not edit their own note, root edited
 * anyone's.
 *
 * SITUATION: test/helpers/tm_note_fixture.ts (identities; engine-built TM rows on
 * test6100, which declares a time_machine_list — test3 does not). Notes are made
 * through create_tm_note's own module (createTmNote); every record, TM row and
 * activity row of the run is swept.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readSectionRecord, searchSectionRecords } from '../../src/ai/mcp/tools/records_read.ts';
import { aclFilterCandidates } from '../../src/ai/rag/retrieval.ts';
import type { Candidate } from '../../src/ai/rag/types.ts';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { canAccessTimeMachineList } from '../../src/core/section/list_definitions/time_machine_list.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	getPermissionGrant,
	getRecordComponentPermission,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession, type Session } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { createTmNote } from '../../src/core/tm_record/tm_note_create.ts';
import {
	TM_NOTES_CODE_TIPO,
	TM_NOTES_SECTION_TIPO,
	TM_NOTES_TEXT,
} from '../../src/core/tm_record/tm_record.ts';
import { assertExportDeclarationReadable } from '../../src/diffusion/export/grid.ts';
import { sweepActivityRows } from '../helpers/activity_rows.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import {
	clearTmNoteCaches,
	forgetDeletedTmNoteRecord,
	installTmNoteFixture,
	mintTmRow,
	removeTmNoteFixture,
	resolveTmNoteIdentities,
	setTmNoteTmAccess,
	TM_NOTE_SECTION,
	type TmNoteIdentities,
	trackTmNoteRecord,
} from '../helpers/tm_note_fixture.ts';

registerSessionCleanup();

const ROOT = -1;
const LANG = 'lg-eng';
const NOTE_TEXT = 'zztmnote ported text';
/** The text the note is BORN with (engine-written in beforeAll): the leak probes look for it. */
const SEED_TEXT = 'zztmnote seeded text';
/** The text of the DOOR-PROBE note (fix 1): never rewritten by any case, so its presence is the leak. */
const LEAK_TEXT = 'zztmleak door probe';

let ids: TmNoteIdentities;
let root: Principal;
let notesTable = '';
const sessions = new Map<number, Session>();
/** Every notes-section / test6100 record of the run (activity sweep). */
const noteIdsOfRun: number[] = [];
const annotatedIdsOfRun: number[] = [];

/** The notes the gate builds (see beforeAll). */
let note = 0; // bound to an AUTHOR row, created by AUTHOR — the main subject
let deletable = 0; // bound, AUTHOR's — consumed by the delete case
let evictable = 0; // bound, AUTHOR's — its dd200 is rewritten by the cache case
let codeless = 0; // NO Code, dd200 = AUTHOR — no valid note
let leakNote = 0; // bound, AUTHOR's, text LEAK_TEXT — the section-level / ddo door probes (fix 1)

function contextFor(principal: Principal): ApiRequestContext {
	let session = sessions.get(principal.userId);
	if (session === undefined) {
		const token = createSession(
			principal.userId,
			`zztmnote_${principal.userId}`,
			principal.isGlobalAdmin,
		);
		session = getSession(token) as Session;
		sessions.set(principal.userId, session);
	}
	return {
		requestId: crypto.randomUUID(),
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session.csrfToken,
		principal,
	} as ApiRequestContext;
}

interface ContextEntry {
	tipo?: unknown;
	section_tipo?: unknown;
	permissions?: unknown;
}
interface Answer {
	code: string | null;
	status: number;
	context: ContextEntry[];
	data: unknown;
}

async function send(rqo: Record<string, unknown>, principal: Principal): Promise<Answer> {
	clearTmNoteCaches();
	const result = await dispatchRqo(structuredClone(rqo) as unknown as Rqo, contextFor(principal));
	const body = result.body as
		| { data?: { context?: ContextEntry[]; data?: unknown } | unknown; error?: { code?: string } }
		| undefined;
	const data = body?.data as { context?: ContextEntry[]; data?: unknown } | undefined;
	return {
		code: body?.error?.code ?? null,
		status: result.status,
		context: Array.isArray(data?.context) ? data.context : [],
		data: data?.data ?? body?.data,
	};
}

/** The note modal's own read (view_note_text_area.js: a component_text_area get_data). */
function noteGetData(principal: Principal, sectionId: number, tipo = TM_NOTES_TEXT) {
	return send(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				action: 'get_data',
				model: tipo === TM_NOTES_TEXT ? 'component_text_area' : 'component_number',
				tipo,
				section_tipo: TM_NOTES_SECTION_TIPO,
				section_id: sectionId,
				mode: 'edit',
				lang: LANG,
			},
		},
		principal,
	);
}

/** The level the get_data stamps on the note text (its context entry). */
function textLevel(answer: Answer): unknown {
	return answer.context.find(
		(entry) => entry.tipo === TM_NOTES_TEXT && entry.section_tipo === TM_NOTES_SECTION_TIPO,
	)?.permissions;
}

/** The note modal's save (component_common.js save → dd_core_api save). */
function noteSave(principal: Principal, sectionId: number, tipo: string, value: unknown) {
	return send(
		{
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				tipo,
				section_tipo: TM_NOTES_SECTION_TIPO,
				section_id: String(sectionId),
				mode: 'edit',
				lang: tipo === TM_NOTES_TEXT ? LANG : 'lg-nolan',
			},
			data: {
				section_id: String(sectionId),
				section_tipo: TM_NOTES_SECTION_TIPO,
				tipo,
				lang: tipo === TM_NOTES_TEXT ? LANG : 'lg-nolan',
				changed_data: [{ action: 'update', id: null, value }],
			},
		},
		principal,
	);
}

const textValue = (text: string) => ({ lang: LANG, value: `<p>${text}</p>` });

/** The note modal's delete button (view_note_text_area.js: delete_record of the note). */
function noteDelete(principal: Principal, sectionId: number) {
	return send(
		{
			action: 'delete',
			dd_api: 'dd_core_api',
			source: {
				delete_mode: 'delete_record',
				tipo: TM_NOTES_SECTION_TIPO,
				section_tipo: TM_NOTES_SECTION_TIPO,
				section_id: sectionId,
			},
		},
		principal,
	);
}

/** A SECTION LIST read of the notes section pinned to one note, showing the text. */
function notesListRead(principal: Principal, sectionId: number, withSource: boolean) {
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		sqo: {
			section_tipo: [TM_NOTES_SECTION_TIPO],
			limit: 10,
			offset: 0,
			filter_by_locators: [{ section_tipo: TM_NOTES_SECTION_TIPO, section_id: String(sectionId) }],
		},
		show: { ddo_map: [{ tipo: TM_NOTES_TEXT, parent: 'self', section_tipo: 'self' }] },
	};
	if (withSource) {
		rqo.source = {
			typo: 'source',
			model: 'section',
			tipo: TM_NOTES_SECTION_TIPO,
			section_tipo: TM_NOTES_SECTION_TIPO,
			action: 'search',
			mode: 'list',
			lang: LANG,
			session_save: false,
		};
	}
	return send(rqo, principal);
}

/** The stored note record (all columns) — the outcome, never the answer. */
async function storedNote(sectionId: number): Promise<string | null> {
	const record = await readMatrixRecord(notesTable, TM_NOTES_SECTION_TIPO, sectionId);
	return record === null ? null : JSON.stringify(record.columns);
}

const levelOf = (principal: Principal, sectionId: number | null, tipo = TM_NOTES_TEXT) =>
	getRecordComponentPermission(principal, TM_NOTES_SECTION_TIPO, tipo, sectionId);

/** A bound note made through the ONE door, as `author` on a fresh row it authored. */
async function boundNote(label: string): Promise<number> {
	const row = await mintTmRow(ids.author.userId, label);
	annotatedIdsOfRun.push(row.sectionId);
	const { sectionId } = await createTmNote(ids.author, row.tmRowId);
	trackTmNoteRecord(TM_NOTES_SECTION_TIPO, sectionId);
	noteIdsOfRun.push(sectionId);
	return sectionId;
}

beforeAll(async () => {
	await assertTestDatabase('subdatum_own_level_ported_native');
	const table = await getMatrixTableFromTipo(TM_NOTES_SECTION_TIPO);
	if (table === null) throw new Error('the TM-notes section has no matrix table');
	notesTable = table;
	await installTmNoteFixture();
	ids = await resolveTmNoteIdentities();
	root = await resolvePrincipal(ROOT);
	note = await boundNote('ported: main');
	const seeded = await saveComponentData({
		componentTipo: TM_NOTES_TEXT,
		sectionTipo: TM_NOTES_SECTION_TIPO,
		sectionId: note,
		lang: LANG,
		changedData: [
			{ action: 'set_data', key: null, value: [{ id: 1, ...textValue(SEED_TEXT) }] } as never,
		],
		userId: ids.author.userId,
	});
	if (!seeded.ok) throw new Error(`seeding the note text failed: ${JSON.stringify(seeded)}`);
	deletable = await boundNote('ported: deletable');
	leakNote = await boundNote('ported: door probe');
	const leakSeeded = await saveComponentData({
		componentTipo: TM_NOTES_TEXT,
		sectionTipo: TM_NOTES_SECTION_TIPO,
		sectionId: leakNote,
		lang: LANG,
		changedData: [
			{ action: 'set_data', key: null, value: [{ id: 1, ...textValue(LEAK_TEXT) }] } as never,
		],
		userId: ids.author.userId,
	});
	if (!leakSeeded.ok)
		throw new Error(`seeding the probe note failed: ${JSON.stringify(leakSeeded)}`);
	evictable = await boundNote('ported: evictable');
	// A record of the notes section with NO Code (no TM row bound) whose creator
	// IS a TM-path user with TM access: not a note, so not managed (Q-b).
	codeless = await createSectionRecord(TM_NOTES_SECTION_TIPO, ids.author.userId);
	trackTmNoteRecord(TM_NOTES_SECTION_TIPO, codeless);
	noteIdsOfRun.push(codeless);
	clearTmNoteCaches();
}, 60_000);

afterAll(async () => {
	await assertTestDatabase('subdatum_own_level_ported_native: sweep');
	await sweepActivityRows(TM_NOTES_SECTION_TIPO, noteIdsOfRun);
	await sweepActivityRows(TM_NOTE_SECTION, annotatedIdsOfRun);
	if (deletable !== 0 && (await storedNote(deletable)) === null) {
		await forgetDeletedTmNoteRecord(TM_NOTES_SECTION_TIPO, deletable);
	}
	await removeTmNoteFixture();
});

describe('the situation (asserted through the real resolver, never trusted)', () => {
	test('TM access, the audit grant and the admin flag are what the personas claim', async () => {
		clearTmNoteCaches();
		expect(await canAccessTimeMachineList(ids.author, TM_NOTE_SECTION)).toBe(true);
		expect(await canAccessTimeMachineList(ids.other, TM_NOTE_SECTION)).toBe(true);
		expect(await canAccessTimeMachineList(ids.noTm, TM_NOTE_SECTION)).toBe(false);
		expect(await canAccessTimeMachineList(ids.auditor, TM_NOTE_SECTION)).toBe(false);
		expect(await canAccessTimeMachineList(ids.admin, TM_NOTE_SECTION)).toBe(true);
		expect(ids.admin.isGlobalAdmin).toBe(true);
		for (const principal of [ids.author, ids.other, ids.noTm, ids.auditor]) {
			expect(principal.isGlobalAdmin).toBe(false);
		}
		expect(await getPermissionGrant(ids.auditor, TM_NOTES_SECTION_TIPO, TM_NOTES_TEXT)).toEqual({
			level: 2,
			basis: 'profile',
		});
		// No TM-path persona holds a PROFILE grant on the notes text.
		for (const principal of [ids.author, ids.other, ids.noTm, ids.admin, root]) {
			const grant = await getPermissionGrant(principal, TM_NOTES_SECTION_TIPO, TM_NOTES_TEXT);
			expect(grant.basis === 'profile' && grant.level > 0).toBe(false);
		}
		const stored = await storedNote(note);
		expect(stored).not.toBeNull();
		const codes = (await sql.unsafe(
			`SELECT section_id, number->$2 AS code, relation->'dd200'->0->>'section_id' AS creator
			   FROM "${notesTable}" WHERE section_tipo = $1 AND section_id = ANY($3::int[])`,
			[TM_NOTES_SECTION_TIPO, TM_NOTES_CODE_TIPO, [note, codeless]],
		)) as { section_id: number; code: unknown; creator: string | null }[];
		const byId = new Map(codes.map((row) => [Number(row.section_id), row]));
		expect(byId.get(note)?.code).not.toBeNull();
		expect(Number(byId.get(note)?.creator)).toBe(ids.author.userId);
		expect(byId.get(codeless)?.code ?? null).toBeNull();
		expect(Number(byId.get(codeless)?.creator)).toBe(ids.author.userId);
	});
});

describe('case 5 — the creator (TM path) edits the text of their own note', () => {
	test('get_data: the text at 2', async () => {
		const answer = await noteGetData(ids.author, note);
		expect(answer.code).toBeNull();
		expect(textLevel(answer)).toBe(2);
	});
	test('save the text: commits', async () => {
		const answer = await noteSave(ids.author, note, TM_NOTES_TEXT, textValue(NOTE_TEXT));
		expect(answer.code).toBeNull();
		expect(await storedNote(note)).toContain(NOTE_TEXT);
	});
});

describe('case 6 — another user with TM access reads, never writes', () => {
	test('get_data: the text at 1, served — from ANOTHER project (matrix_notes is projects-exempt: the TM path never hangs on the creator’s projects)', async () => {
		const answer = await noteGetData(ids.other, note);
		expect(answer.code).toBeNull();
		expect(textLevel(answer)).toBe(1);
		expect(JSON.stringify(answer.data)).toContain(NOTE_TEXT);
	});
	test('save the text: perm.denied, the note unchanged', async () => {
		const before = await storedNote(note);
		const answer = await noteSave(ids.other, note, TM_NOTES_TEXT, textValue('zz other wrote'));
		expect(answer.code).toBe('perm.denied');
		expect(await storedNote(note)).toBe(before);
	});
});

describe('case 7 — a global admin and root are on the TM path: read only', () => {
	for (const persona of ['admin', 'root'] as const) {
		test(`${persona}: get_data 1, save perm.denied`, async () => {
			const principal = persona === 'root' ? root : ids.admin;
			const read = await noteGetData(principal, note);
			expect(read.code).toBeNull();
			expect(textLevel(read)).toBe(1);
			const before = await storedNote(note);
			const answer = await noteSave(principal, note, TM_NOTES_TEXT, textValue(`zz ${persona}`));
			expect(answer.code).toBe('perm.denied');
			expect(await storedNote(note)).toBe(before);
		});
	}
});

describe('case 8 — no TM access: no note', () => {
	test('get_data: refused, the text never served', async () => {
		const answer = await noteGetData(ids.noTm, note);
		expect(answer.code).toBe('perm.denied');
		expect(JSON.stringify(answer.data ?? null)).not.toContain('zztmnote');
		expect(await levelOf(ids.noTm, note)).toBe(0);
	});
	test('a section list read of the notes section serves no note text (the public-list fallback)', async () => {
		// Non-vacuous: the same read DOES serve the text to the auditor (profile grant).
		const audited = await notesListRead(ids.auditor, note, true);
		expect(audited.code).toBeNull();
		expect(JSON.stringify(audited.data ?? null)).toContain('zztmnote');
		const answer = await notesListRead(ids.noTm, note, true);
		expect(JSON.stringify(answer.data ?? null)).not.toContain('zztmnote');
	});
});

describe('case 9 — the AUDIT path: a profile grant on the notes section', () => {
	test('the auditor saves the creator’s note text; the notes section’s own TM records it', async () => {
		const answer = await noteSave(ids.auditor, note, TM_NOTES_TEXT, textValue('zz audited'));
		expect(answer.code).toBeNull();
		expect(await storedNote(note)).toContain('zz audited');
		const audit = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND user_id = $4::text`,
			[TM_NOTES_SECTION_TIPO, note, TM_NOTES_TEXT, ids.auditor.userId],
		)) as { n: number }[];
		expect(audit[0]?.n).toBe(1);
	});
});

describe('case 10 — a creator who LOST TM access: 0 (Q-d)', () => {
	test('revoked → 0 and refused; restored → 2', async () => {
		await setTmNoteTmAccess(ids.author.userId, 0);
		try {
			expect(await levelOf(ids.author, note)).toBe(0);
			expect((await noteGetData(ids.author, note)).code).toBe('perm.denied');
		} finally {
			await setTmNoteTmAccess(ids.author.userId, 1);
		}
		expect(await levelOf(ids.author, note)).toBe(2);
	});
});

describe('case 11 — the note-facts cache evicts on a notes-section write', () => {
	test('dd200 rewritten through the engine → the next ask reflects it', async () => {
		clearTmNoteCaches();
		expect(await levelOf(ids.author, evictable)).toBe(2);
		expect(await levelOf(ids.other, evictable)).toBe(1);
		const saved = await saveComponentData({
			componentTipo: 'dd200',
			sectionTipo: TM_NOTES_SECTION_TIPO,
			sectionId: evictable,
			lang: 'lg-nolan',
			changedData: [
				{
					action: 'set_data',
					key: null,
					value: [
						{
							type: 'dd151',
							section_id: ids.other.userId,
							section_tipo: 'dd128',
							from_component_tipo: 'dd200',
						},
					],
				} as never,
			],
			userId: ROOT,
		});
		expect(saved.ok).toBe(true);
		// NO cache clear here: the save event is the only eviction.
		expect(await levelOf(ids.other, evictable)).toBe(2);
		expect(await levelOf(ids.author, evictable)).toBe(1);
	});
});

describe('case 13 — the Code is the server’s: nobody on the TM path writes it', () => {
	test('the creator saves the Code on their own note → perm.denied, the Code unchanged', async () => {
		expect(await levelOf(ids.author, note, TM_NOTES_CODE_TIPO)).toBe(1);
		const before = await storedNote(note);
		const answer = await noteSave(ids.author, note, TM_NOTES_CODE_TIPO, { value: 1 });
		expect(answer.code).toBe('perm.denied');
		expect(await storedNote(note)).toBe(before);
	});
});

describe('case 14 — a Code-less record is no note (Q-b)', () => {
	test('its creator, with TM access, holds 0 and is refused', async () => {
		expect(await levelOf(ids.author, codeless)).toBe(0);
		expect((await noteGetData(ids.author, codeless)).code).toBe('perm.denied');
	});
	test('the auditor (profile grant) still manages it', async () => {
		expect(await levelOf(ids.auditor, codeless)).toBe(2);
	});
});

describe('case 15 — the creator deletes their own note; others are refused', () => {
	test('another user (TM access, read 1): perm.denied, the note stays', async () => {
		const answer = await noteDelete(ids.other, deletable);
		expect(answer.code).toBe('perm.denied');
		expect(await storedNote(deletable)).not.toBeNull();
	});
	test('a user without TM access: perm.denied, the note stays', async () => {
		const answer = await noteDelete(ids.noTm, deletable);
		expect(answer.code).toBe('perm.denied');
		expect(await storedNote(deletable)).not.toBeNull();
	});
	test('the creator: deleted', async () => {
		const answer = await noteDelete(ids.author, deletable);
		expect(answer.code).toBeNull();
		expect(await storedNote(deletable)).toBeNull();
	});
});

describe('Q-c — a node stamp (no record) is max(profile, 0)', () => {
	test('TM-path personas 0 (root included); the auditor its profile 2', async () => {
		clearTmNoteCaches();
		for (const principal of [ids.author, ids.other, ids.noTm, ids.admin, root]) {
			expect({ user: principal.userId, level: await levelOf(principal, null) }).toEqual({
				user: principal.userId,
				level: 0,
			});
		}
		expect(await levelOf(ids.auditor, null)).toBe(2);
	});
	test('the auditor on a bound note: max(profile 2, TM path 0) = 2', async () => {
		expect(await levelOf(ids.auditor, note)).toBe(2);
	});
});

// ── FIX 1 — the notes section at every SECTION-level / ddo door ──────────────
//
// The notes section lives in matrix_notes, a PUBLIC-LIST table: the 'rule'
// fallback of getPermissionGrant answered read 1 to every user on every
// (notes section, *) pair, so every door built on getPermissions /
// ddoIsAuthorized / pairGranted served every note's text — whatever the TM
// path said. After: the bare matrix decides there (only the AUDIT path — a
// profile grant — reaches the notes section as a section); the record-addressed
// component get_data (the note modal) still serves the TM path. DATA is
// asserted, never only a stamp. A global admin keeps the read it had (owner to
// decide) — ONE predicate, the same answer at every door (pinned below).

/** read_raw over the probe note — `type` section (every column) or component (the text). */
function readRawProbe(principal: Principal, type: 'section' | 'component') {
	return send(
		{
			action: 'read_raw',
			dd_api: 'dd_core_api',
			options: {
				section_tipo: TM_NOTES_SECTION_TIPO,
				tipo: type === 'section' ? TM_NOTES_SECTION_TIPO : TM_NOTES_TEXT,
				type,
			},
			sqo: {
				section_tipo: [TM_NOTES_SECTION_TIPO],
				filter_by_locators: [{ section_tipo: TM_NOTES_SECTION_TIPO, section_id: leakNote }],
				limit: 1,
			},
		},
		principal,
	);
}

/** The export declaration gate for a notes-text column over the notes section. */
function exportProbe(principal: Principal) {
	return assertExportDeclarationReadable(principal, {
		section_tipo: TM_NOTES_SECTION_TIPO,
		sqo: { section_tipo: [TM_NOTES_SECTION_TIPO] },
		ar_ddo_to_export: [
			{ path: [{ section_tipo: TM_NOTES_SECTION_TIPO, component_tipo: TM_NOTES_TEXT }] },
		],
	});
}

/** A RAG chunk of the probe note's text. */
function leakChunk(): Candidate {
	return {
		sectionTipo: TM_NOTES_SECTION_TIPO,
		sectionId: leakNote,
		componentTipo: TM_NOTES_TEXT,
		lang: LANG,
		chunkIndex: 0,
		sourceText: LEAK_TEXT,
		sourceKind: 'text',
		modality: 'text',
		egressClass: null,
		parentKey: null,
		chunkMeta: null,
	};
}

const leaks = (value: unknown): boolean => JSON.stringify(value ?? null).includes('zztmleak');

describe('fix 1 — no section-level / ddo door serves a note to the TM path (the public-list leak)', () => {
	const tmPath = () =>
		[
			['no TM access', ids.noTm],
			['other (TM access)', ids.other],
			['creator (TM access)', ids.author],
		] as const;

	test('read_raw type section: withheld from the TM path; served to the auditor', async () => {
		const audited = await readRawProbe(ids.auditor, 'section');
		expect(audited.code).toBeNull();
		expect(leaks(audited.data)).toBe(true);
		for (const [label, principal] of tmPath()) {
			const answer = await readRawProbe(principal, 'section');
			expect({ label, code: answer.code, leaks: leaks(answer.data) }).toEqual({
				label,
				code: 'perm.denied',
				leaks: false,
			});
		}
	});

	test('read_raw type component (the text): withheld from the TM path; served to the auditor', async () => {
		const audited = await readRawProbe(ids.auditor, 'component');
		expect(audited.code).toBeNull();
		expect(leaks(audited.data)).toBe(true);
		for (const [label, principal] of tmPath()) {
			const answer = await readRawProbe(principal, 'component');
			expect({ label, code: answer.code, leaks: leaks(answer.data) }).toEqual({
				label,
				code: 'perm.denied',
				leaks: false,
			});
		}
	});

	test('MCP dedalo_read_record: refused to the TM path; the text served to the auditor', async () => {
		clearTmNoteCaches();
		const input = { section_tipo: TM_NOTES_SECTION_TIPO, section_id: leakNote, mode: 'edit' };
		const audited = await readSectionRecord(ids.auditor, input);
		expect(leaks(audited.data)).toBe(true);
		for (const [label, principal] of tmPath()) {
			const refusal = await refusalOf(readSectionRecord(principal, input));
			expect({ label, code: refusal.code, leaks: leaks(refusal) }).toEqual({
				label,
				code: 'perm.denied',
				leaks: false,
			});
		}
	});

	test('MCP dedalo_search_section with a text filter (the text oracle): refused to the TM path; the auditor finds the note', async () => {
		clearTmNoteCaches();
		const input = {
			section_tipo: TM_NOTES_SECTION_TIPO,
			filter: { component_tipo: TM_NOTES_TEXT, query: 'zztmleak', lang: LANG },
		};
		const audited = await searchSectionRecords(ids.auditor, input);
		expect(audited.hits.map((hit) => hit.section_id)).toContain(leakNote);
		for (const [label, principal] of tmPath()) {
			const refusal = await refusalOf(searchSectionRecords(principal, input));
			expect({ label, code: refusal.code }).toEqual({ label, code: 'perm.denied' });
		}
	});

	test('tool_export declaration gate: refused to the TM path; the auditor passes', async () => {
		clearTmNoteCaches();
		await exportProbe(ids.auditor);
		for (const [label, principal] of tmPath()) {
			const refusal = await refusalOf(exportProbe(principal));
			expect({ label, code: refusal.code }).toEqual({ label, code: 'perm.denied' });
		}
	});

	test('RAG retrieval ACL: the note chunk dropped for the TM path; served to the auditor', async () => {
		clearTmNoteCaches();
		const audited = await aclFilterCandidates(ids.auditor, [leakChunk()]);
		expect(audited.map((chunk) => chunk.sectionId)).toEqual([leakNote]);
		for (const [label, principal] of tmPath()) {
			const served = await aclFilterCandidates(principal, [leakChunk()]);
			expect({ label, served: served.length }).toEqual({ label, served: 0 });
		}
	});

	test('the note modal’s get_data STILL serves the text on the TM path — creator (2) and other (1); no TM access refused', async () => {
		const creator = await noteGetData(ids.author, leakNote);
		expect(creator.code).toBeNull();
		expect(textLevel(creator)).toBe(2);
		expect(leaks(creator.data)).toBe(true);
		const other = await noteGetData(ids.other, leakNote);
		expect(other.code).toBeNull();
		expect(textLevel(other)).toBe(1);
		expect(leaks(other.data)).toBe(true);
		const none = await noteGetData(ids.noTm, leakNote);
		expect(none.code).toBe('perm.denied');
		expect(leaks(none.data)).toBe(false);
	});

	test('a global admin: ONE answer at every section-level door (read, as before — owner to decide)', async () => {
		const list = await notesListRead(ids.admin, leakNote, true);
		expect(list.code).toBeNull();
		const raw = await readRawProbe(ids.admin, 'component');
		expect(raw.code).toBeNull();
		expect(leaks(raw.data)).toBe(true);
		const mcp = await readSectionRecord(ids.admin, {
			section_tipo: TM_NOTES_SECTION_TIPO,
			section_id: leakNote,
			mode: 'edit',
		});
		expect(leaks(mcp.data)).toBe(true);
	});
});

// ── FIX 4 — a TM note is never DUPLICATED (owner Q-b) ─────────────────────────
//
// duplicate copies the Code and stamps dd200 = the caller: a SECOND
// note bound to the same TM row, not created through create_tm_note, owned by
// someone who never made the change. Refused for every caller — the auditor
// (a profile grant passes the section door) and root included — at the
// duplicate ENGINE, so every door that duplicates (dd_core_api, MCP, tools)
// inherits it.

describe('fix 4 — duplicate of a TM note is refused for every caller', () => {
	async function notesCount(): Promise<number> {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${notesTable}" WHERE section_tipo = $1`,
			[TM_NOTES_SECTION_TIPO],
		)) as { n: number }[];
		return rows[0]?.n ?? -1;
	}
	const duplicate = (principal: Principal) =>
		send(
			{
				action: 'duplicate',
				dd_api: 'dd_core_api',
				source: {
					section_tipo: TM_NOTES_SECTION_TIPO,
					tipo: TM_NOTES_SECTION_TIPO,
					section_id: leakNote,
				},
			},
			principal,
		);

	for (const persona of ['auditor', 'root', 'author'] as const) {
		test(`${persona}: perm.denied, no note minted`, async () => {
			const principal = persona === 'root' ? root : ids[persona];
			const before = await notesCount();
			const answer = await duplicate(principal);
			// A record a refused duplicate minted anyway is swept, never left behind.
			const minted = (answer.data as { section_id?: unknown } | null)?.section_id;
			if (typeof minted === 'number') {
				trackTmNoteRecord(TM_NOTES_SECTION_TIPO, minted);
				noteIdsOfRun.push(minted);
			}
			expect({ persona, code: answer.code }).toEqual({ persona, code: 'perm.denied' });
			expect(await notesCount()).toBe(before);
		});
	}

	test('the ENGINE refuses it, whatever a door’s New-button predicate says (the doors above stop at the notes section’s missing button_new — an ontology fact, not this rule)', async () => {
		const before = await notesCount();
		let minted: number | null = null;
		const refusal = await refusalOf(
			duplicateSectionRecord(TM_NOTES_SECTION_TIPO, leakNote, ROOT).then((id) => {
				minted = id;
				trackTmNoteRecord(TM_NOTES_SECTION_TIPO, id);
				noteIdsOfRun.push(id);
				return id;
			}),
		);
		expect({ code: refusal.code, minted }).toEqual({ code: 'perm.denied', minted: null });
		expect(refusal.message).toContain('create_tm_note');
		expect(await notesCount()).toBe(before);
	});
});

// ── FIX 7 — the bound TM row is resolved on EVERY ask, never cached ───────────
//
// The note-facts cache is evicted only by notes-section writes; the TM row it
// is bound to changes by OTHER writes (a hidden undo-log row, a purge). A
// cached "bound section" kept granting the note after its change was gone.
// Only what a notes-section write changes (creator, Code) may be cached.

describe('fix 7 — a hidden or purged TM row stops granting its note at once (no cache clear)', () => {
	for (const how of ['hidden', 'purged'] as const) {
		test(`${how}: the next ask answers 0`, async () => {
			const row = await mintTmRow(ids.author.userId, `ported: ${how} row`);
			annotatedIdsOfRun.push(row.sectionId);
			const { sectionId } = await createTmNote(ids.author, row.tmRowId);
			trackTmNoteRecord(TM_NOTES_SECTION_TIPO, sectionId);
			noteIdsOfRun.push(sectionId);
			clearTmNoteCaches();
			// Warm the cache through the real resolver.
			expect(await levelOf(ids.other, sectionId)).toBe(1);
			expect(await levelOf(ids.author, sectionId)).toBe(2);
			await assertTestDatabase('fix 7 TM row mutation');
			if (how === 'hidden') {
				await sql.unsafe('UPDATE matrix_time_machine SET tm_role = 3 WHERE id = $1', [row.tmRowId]);
			} else {
				await sql.unsafe('DELETE FROM matrix_time_machine WHERE id = $1', [row.tmRowId]);
			}
			// NO cache clear: the row is not the cache's to remember.
			expect(await levelOf(ids.other, sectionId)).toBe(0);
			expect(await levelOf(ids.author, sectionId)).toBe(0);
		});
	}
});
