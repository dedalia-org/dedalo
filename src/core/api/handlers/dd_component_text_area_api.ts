/**
 * dd_component_text_area_api handlers (PHP
 * core/api/v1/common/class.dd_component_text_area_api.php).
 *
 * Both PHP actions are ported (WC-077), plus one TS-native action:
 *  - `get_tags_info` — READ: resolve a transcription's marks into the records
 *    they point at (tool_tr_print's feed). AUTHZ (WC-077 AUTHZ-01 as amended
 *    by WC-2026-11-10-tags-info-read-door): the write door's READ mode first —
 *    section >= 1, the text_area's pair grant, the record scope — BEFORE the
 *    options; then every hop under the same principal (note records, host
 *    tag-source components, the persons inverse search);
 *  - `delete_tag` — WRITE: remove one tag's marks from EVERY language of the
 *    text (tool_indexation's step 1; its step 2, the portal locator, is
 *    dd_component_portal_api::delete_locator, which PHP deliberately moved out
 *    of this action and the client calls right after).
 *
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md): a refusal is a THROWN registry code
 * (the dispatch catch converts it); a success is `ok(data)`. delete_tag's data
 * is still the BOOLEAN PHP computed ($n_deleted > 0) — that falsiness is
 * LOAD-BEARING: the client only removes the editor's own tag markup when the
 * answer is not false (component_text_area.js:1372), so "nothing matched" must
 * stay a falsy SUCCESS, never an error.
 */

import { coerceSectionId } from '../../concepts/section_id.ts';
import { ok } from '../../errors/convert.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { specOf } from '../../errors/registry.ts';
import type { ApiNotice } from '../../errors/schema.ts';
import type { ActionHandler } from '../handler_context.ts';
import { requirePrincipal } from '../handler_context.ts';

/** dd_component_text_area_api action handlers (registered in dispatch.ts). */
export const componentTextAreaApiActions: Record<string, ActionHandler> = {
	get_tags_info: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const source = (rqo.source ?? {}) as {
			tipo?: unknown;
			section_tipo?: unknown;
			section_id?: unknown;
			lang?: unknown;
		};
		const options = (rqo.options ?? {}) as { ar_type?: unknown };
		const tipo = String(source.tipo ?? '');
		const sectionTipo = String(source.section_tipo ?? '');
		// The host of a transcription is always a matrix record: coerce at the
		// door (counted, deprecable RQO-body string form) so nothing downstream
		// carries a string leg (WC-2026-08-10-section-id-int-canonical). A
		// non-address is REFUSED BY NAME — never folded into "mandatory field
		// missing", which would hide a client sending the wrong kind of id.
		let sectionId: number | undefined;
		try {
			sectionId =
				source.section_id === undefined || source.section_id === null
					? undefined
					: coerceSectionId(
							source.section_id,
							'rqo.dd_component_text_area_api.get_tags_info.section_id',
						);
		} catch (error) {
			// The coercer's own message names the offending value — LOG-ONLY.
			throw new DedaloError('request.invalid_source', {
				cause: error,
				coordinates: {
					section_id: JSON.stringify(source.section_id ?? null),
					section_tipo: sectionTipo,
				},
			});
		}
		if (tipo === '' || sectionTipo === '' || sectionId === undefined) {
			throw new DedaloError('request.invalid_source', {
				message:
					'get_tags_info: source.tipo, source.section_tipo and source.section_id are mandatory',
			});
		}

		// THE READ DOOR (T0-3, WC-2026-11-10-tags-info-read-door): the write
		// door's READ mode — the section floor (>= 1, PHP's own
		// assert_section_permission), the text_area's own pair grant
		// (read_door.authorizeComponentRead) and the record scope
		// (perm.out_of_scope). Asked BEFORE the options are read: an
		// unauthorized caller learns nothing about the action's own grammar
		// (delete_tag's order). The hops the feed resolves (note records, the
		// host's tag-source components, the persons inverse search) are gated
		// inside buildTagsInfo with the SAME principal.
		const { authorizeRecordAccess } = await import('../../security/write_door.ts');
		const grant = await authorizeRecordAccess(
			principal,
			{ section_tipo: sectionTipo, component_tipo: tipo, section_id: sectionId },
			{
				mode: 'read',
				level: 1,
				sectionFloor: 1,
				door: 'dd_component_text_area_api.get_tags_info',
			},
		);

		// PHP took `options.ar_type` verbatim; a non-array is a client bug, and
		// defaulting it would serve a payload nobody asked for.
		const requestedTypes = Array.isArray(options.ar_type)
			? options.ar_type.filter((type): type is string => typeof type === 'string')
			: [];
		if (requestedTypes.length === 0) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'options.ar_type must be a non-empty array of tag types',
			});
		}

		// The request's data lang when the client names one (the text_area is
		// per-lang: its notes and text belong to the lang being transcribed).
		const { currentDataLang } = await import('../../resolve/request_lang.ts');
		const lang =
			typeof source.lang === 'string' && source.lang !== '' ? source.lang : currentDataLang();

		const { buildTagsInfo } = await import('../../components/component_text_area/tags_info.ts');
		// The effect addresses what was AUTHORIZED — the grant, never the rqo.
		const { tags_info, unknown_types, withheld_notes } = await buildTagsInfo(
			requestedTypes,
			{
				tipo: grant.componentTipo,
				section_tipo: grant.sectionTipo,
				section_id: grant.sectionId,
			},
			lang,
			principal,
		);
		// A hop the caller may not read (a host tag-source component) is refused
		// LOUDLY by the read door's own recorder: one perm.out_of_scope notice.
		const { readDoorNotices } = await import('../../security/read_door.ts');
		const notices = readDoorNotices();

		// Never silently narrow: an unresolvable type is NAMED — as an owned
		// top-level key now that the prose channel is gone (the answer itself is
		// valid, so this is not an error and not a coded notice either: the types
		// are caller-supplied strings, not a closed vocabulary). A note the caller
		// may not read is dropped and its id NAMED in the owned `withheld_notes`
		// key (owner OD-2 (a)): the id is already in the transcription's own mark,
		// so naming it discloses nothing the text does not.
		return {
			status: 200,
			body: ok(tags_info, {
				requestId: context.requestId,
				extend: { unknown_types, withheld_notes },
				...(notices === undefined ? {} : { notices }),
			}),
		};
	},

	delete_tag: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const source = (rqo.source ?? {}) as {
			tipo?: unknown;
			section_tipo?: unknown;
			section_id?: unknown;
		};
		const options = (rqo.options ?? {}) as { tag_id?: unknown; type?: unknown };
		const tipo = String(source.tipo ?? '');
		const sectionTipo = String(source.section_tipo ?? '');
		const sectionId = Number(source.section_id);
		const tagId = String(options.tag_id ?? '');
		const tagType = String(options.type ?? '');
		if (tipo === '' || sectionTipo === '' || !Number.isInteger(sectionId) || sectionId <= 0) {
			throw new DedaloError('request.invalid_source', {
				message:
					'delete_tag: source.tipo, source.section_tipo and a positive source.section_id are mandatory',
			});
		}
		// SEC — THE WRITE DOOR (closure Step 3): level >= 2 on the (section,
		// component) pair WITH the dd128 own-record rule, then the record scope
		// (the non-positive-id refusal ahead of the admin bypass). Asked BEFORE the
		// options are read: an unauthorized caller learns nothing about the
		// action's own grammar.
		//
		// sectionFloor 0 — THE SAVE DOOR'S NAMED EXCEPTION, on its twin: deleting a
		// tag IS an edit of this text_area's value (the same inline-edit write on the
		// same component the `save` door authorizes at floor 0 — a subdatum portal
		// target the profile holds 0 on at the section). Asking the section here
		// would refuse a tag delete on a text_area its editor may save. It converges
		// WITH the save door (WC-2026-09-30-write-door owner-review item), never
		// apart from it.
		const { authorizeRecordAccess } = await import('../../security/write_door.ts');
		const grant = await authorizeRecordAccess(
			principal,
			{ section_tipo: sectionTipo, component_tipo: tipo, section_id: sectionId },
			{ mode: 'write', level: 2, sectionFloor: 0, door: 'dd_component_text_area_api.delete_tag' },
		);

		if (tagId === '') {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'options.tag_id is mandatory',
			});
		}

		// Only the paired mark families are deletable by id (WC-077). An
		// unsupported type is NAMED, never treated as a no-op success.
		const { ID_TARGETED_MARK_TYPES } = await import('../../resolve/tr_marks.ts');
		if (!(ID_TARGETED_MARK_TYPES as readonly string[]).includes(tagType)) {
			throw new DedaloError('request.invalid_options', {
				// Public: the sentence states the CLOSED supported set, never the
				// rejected value (which is caller data).
				publicMessage: `options.type must be one of ${ID_TARGETED_MARK_TYPES.join(', ')}`,
				message: `delete_tag: tag type '${tagType}' is not deletable by id`,
			});
		}

		const { deleteTagFromAllLangs } = await import(
			'../../components/component_text_area/tag_delete.ts'
		);
		const { getModelByTipo } = await import('../../ontology/resolver.ts');
		let outcome: Awaited<ReturnType<typeof deleteTagFromAllLangs>>;
		try {
			// The effect addresses what was AUTHORIZED — the grant, never the rqo.
			outcome = await deleteTagFromAllLangs({
				componentTipo: grant.componentTipo,
				sectionTipo: grant.sectionTipo,
				sectionId: grant.sectionId,
				tagId,
				tagType: tagType as 'index' | 'reference',
				userId: principal.userId,
			});
		} catch (error) {
			// markPatternById throws on a malformed tag_id — a rejected request,
			// not a server fault. Its message names the offending id: LOG-ONLY.
			throw new DedaloError('request.invalid_options', {
				cause: error,
				publicMessage: 'options.tag_id is malformed',
				coordinates: { tipo, section_tipo: sectionTipo, section_id: sectionId },
			});
		}

		// PHP message bytes (class.dd_component_text_area_api.php:71-74) — now the
		// LOG line: the wire carries the boolean + the two owned counters.
		const model = (await getModelByTipo(tipo)) ?? '';
		const total = outcome.langsChanged.length;
		console.info(
			total > 0
				? `[delete_tag] deleted tag: ${tagId} (${tagType}) in ${total} langs: ${outcome.langsChanged.join(', ')} (${model} - ${tipo})`
				: `[delete_tag] no tags are deleted in ${model} tipo: '${tipo}' tag_id: '${tagId}' type: '${tagType}'`,
		);
		return {
			status: 200,
			// PHP: result = ($n_deleted > 0). The client's editor-tag removal depends
			// on this exact falsiness (see the module doc) — it reads the compat
			// mirror today and `data` after the client half lands.
			body: ok(outcome.removedCount > 0 && outcome.error === undefined, {
				requestId: context.requestId,
				notices: partialWriteNotices(outcome.error),
				extend: {
					langs_changed: outcome.langsChanged,
					removed_count: outcome.removedCount,
				},
			}),
		};
	},

	/**
	 * CREATE (or answer) the Time Machine note bound to one TM row — the ONE
	 * door that makes an rsc832 note (T0-4 part B; tm_record/tm_note_create.ts).
	 * `options.matrix_id` is the row id the TM cell served. The admission is the
	 * action's own and is decided inside the module, BEFORE anything is written:
	 * a well-formed id (else request.invalid_data) naming a row that exists, whose
	 * author is the caller, who has TM access to its section — else ONE
	 * perm.denied, whichever half failed (no existence oracle on TM row ids). No rsc832 section grant
	 * is asked — that is the point: a generic section-level create makes a
	 * Code-less record, which is no TM note. Answers `{ section_id }` — the new
	 * note's, or the note that already binds the row (never a duplicate); the
	 * owned extension key `created` says which.
	 */
	create_tm_note: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const options = (rqo.options ?? {}) as { matrix_id?: unknown };
		const { createTmNote } = await import('../../tm_record/tm_note_create.ts');
		const { sectionId, created } = await createTmNote(principal, options.matrix_id);
		return {
			status: 200,
			body: ok({ section_id: sectionId }, { requestId: context.requestId, extend: { created } }),
		};
	},
};

/**
 * A PARTIAL write is reported, never swallowed: the langs already cleaned ride
 * in `langs_changed`, the failure as a coded NOTICE — the answer is a FALSY
 * SUCCESS, not a failed request (re-issuing it is safe), so it cannot be a
 * throw. The engine's own message is the log line, never a wire field.
 */
function partialWriteNotices(error: string | undefined): ApiNotice[] | undefined {
	if (error === undefined) return undefined;
	console.error(`[delete_tag] partial write: ${error}`);
	const spec = specOf('record.save_failed');
	return [{ code: 'record.save_failed', label_key: spec.label_key, retryable: spec.retryable }];
}
