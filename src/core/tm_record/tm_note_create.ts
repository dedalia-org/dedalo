/**
 * CREATE A TIME MACHINE NOTE — the ONE door (T0-4 part B; owner Q-a + Q-b,
 * 2026-11-10). Wire: `dd_component_text_area_api::create_tm_note`.
 *
 * A TM note (section rsc832: text rsc329, Code rsc835 = the matrix_time_machine
 * row id, creator = its dd200 relation) is valid ONLY when created from the
 * Time Machine (the inspector component-history panel or the TM interface) and
 * BOUND to its TM row at creation. Users never write nor choose the Code: this
 * module writes it, server-side, in the same transaction that creates the
 * record. The client sends the row id it was SERVED (`matrix_id`, read_tm.ts) —
 * a handle, never a value: the admission below re-proves everything about it.
 *
 * THE ADMISSION — named, narrow, and the whole of it (the caller holds no
 * rsc832 section grant; a section-level create, write_door.authorizeSectionCreate,
 * would refuse them, and that is deliberate: a generic `create` on rsc832 makes
 * a Code-less record, which is no TM note):
 *   0. a malformed / absent id → `request.invalid_data` (no row is named);
 *   1. the row exists and is visible history (readTimeMachineRow);
 *   2. TM ACCESS to the annotated section: canAccessTimeMachineList(principal,
 *      row.section_tipo) — the §7.4 time_machine_list grant; a global admin
 *      passes this half (timeMachineReadFloor parity);
 *   3. AUTHORSHIP: the row's user_id IS the caller — nobody else, root and
 *      global admins included, annotates a change they did not make.
 *   1, 2 or 3 failing → ONE `perm.denied`, same message and coordinates (the
 *   reason is not told: an unknown row answered differently from a row that is
 *   not yours would let a caller enumerate TM row ids).
 *
 * ONE NOTE PER ROW. Under a transaction-scoped advisory lock keyed by the row,
 * a note already binding it (findTmNoteSectionId — the TM cell's own lookup) is
 * ANSWERED, never duplicated (the lost-id bug minted one per click). Else the
 * record is created through the record-create chokepoint (createSectionRecord:
 * dd200 = caller, birth defaults, NEW activity, every post-write obligation)
 * and the Code is written through the save chokepoint (saveComponentData:
 * TM-audited in rsc832's own history). Both join this one transaction: a
 * failure leaves no unbound note behind.
 */

import { NO_LANG } from '../../config/data_langs.ts';
import { acquireNodeLock, withTransaction } from '../db/postgres.ts';
import { readTimeMachineRow } from '../db/time_machine.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { canAccessTimeMachineList } from '../section/list_definitions/time_machine_list.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import type { Principal } from '../security/permissions.ts';
import { findTmNoteSectionId, TM_NOTES_CODE_TIPO, TM_NOTES_SECTION_TIPO } from './tm_record.ts';

/** The door id this module answers for (logs, coordinates). */
export const CREATE_TM_NOTE_DOOR = 'dd_component_text_area_api.create_tm_note';

/** The outcome: the note's address, and whether THIS call created it. */
export interface TmNoteCreateResult {
	sectionId: number;
	created: boolean;
}

/**
 * The TM row id as the client sends it: a positive safe integer (a decimal
 * digit string is accepted — the same value, a JSON-transport form). Anything
 * else is no row id.
 */
export function parseTmRowId(value: unknown): number | null {
	const candidate =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)
				? Number(value)
				: Number.NaN;
	return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
}

/** Create (or answer) the note bound to TM row `rawMatrixId`, as `principal`. See the module doc. */
export async function createTmNote(
	principal: Principal,
	rawMatrixId: unknown,
): Promise<TmNoteCreateResult> {
	const matrixId = parseTmRowId(rawMatrixId);
	if (matrixId === null) {
		throw new DedaloError('request.invalid_data', {
			publicMessage: 'options.matrix_id must be a Time Machine row id',
			message: `${CREATE_TM_NOTE_DOOR}: matrix_id ${JSON.stringify(rawMatrixId ?? null)} is not a row id`,
		});
	}
	return withTransaction(async () => {
		// Serializes two creates for the same row (a double click, two tabs): the
		// second waits, then finds the first one's note below.
		await acquireNodeLock(TM_NOTES_SECTION_TIPO, `tm_${matrixId}`);

		// ONE refusal for every well-formed id the caller may not annotate — unknown,
		// hidden, not theirs, or without TM access: telling them apart would let a
		// caller enumerate which TM row ids exist (an existence oracle).
		const row = await readTimeMachineRow(matrixId);
		const author = row === null || row.user_id === null ? null : Number(row.user_id);
		if (
			row === null ||
			author !== principal.userId ||
			!(await canAccessTimeMachineList(principal, row.section_tipo))
		) {
			throw new DedaloError('perm.denied', {
				message: `${CREATE_TM_NOTE_DOOR}: user ${principal.userId} may not annotate TM row ${matrixId}`,
				coordinates: { matrix_id: matrixId, operation: 'create_tm_note' },
			});
		}

		const existing = await findTmNoteSectionId(matrixId);
		if (existing !== null) return { sectionId: existing, created: false };

		const sectionId = await createSectionRecord(TM_NOTES_SECTION_TIPO, principal.userId);
		const saved = await saveComponentData({
			componentTipo: TM_NOTES_CODE_TIPO,
			sectionTipo: TM_NOTES_SECTION_TIPO,
			sectionId,
			lang: NO_LANG,
			changedData: [{ action: 'set_data', key: null, value: [{ value: matrixId }] }],
			userId: principal.userId,
			principal,
		});
		if (!saved.ok) {
			// Thrown INSIDE the transaction: the record above rolls back with it, so
			// no Code-less note survives a failed binding.
			throw new DedaloError('record.save_failed', {
				message: `${CREATE_TM_NOTE_DOOR}: binding note ${sectionId} to TM row ${matrixId} failed: ${saved.message}`,
				coordinates: { section_tipo: TM_NOTES_SECTION_TIPO, section_id: sectionId },
			});
		}
		return { sectionId, created: true };
	});
}
