/**
 * tool_tc server module — bulk-offset every timecode in a transcription text
 * component (PHP tool_tc::change_all_timecodes). Gate: 'record_tipo' level 2
 * (the (section, component) PAIR *and* the record's projects scope — PHP
 * assert_tipo_permission + assert_record_in_user_scope, :136-139).
 *
 * Shape (PHP :180-220): read the component's LANG SLICE (get_data_lang), offset
 * each element's TC marks (replaceTimecodes: clamp >= 0, reverse-order for
 * positive offsets), rebuild the WHOLE slice, and write it back with ONE
 * set_data_lang() + save().
 *
 * Three contracts this module is pinned on (audit 2026-07-28, group B —
 * test/unit/media_timecode.test.ts, WC-061):
 *
 * - ONE SAVE, NOT ONE PER ITEM. The offset application is atomic per component:
 *   a single `set_data` change carrying the rebuilt slice, so
 *   saveComponentData's transaction covers the whole set and exactly ONE Time
 *   Machine row is appended. Saving per item (the original port) meant a
 *   mid-loop failure committed a HALF-OFFSET transcription with nothing on the
 *   wire to say so — unrecoverable by inspection, since every prefix looks like
 *   a legitimate edit.
 * - `key` INDEXES THE LANG SLICE. PHP's get_data_lang runs array_values, so its
 *   $raw_key is 0..n-1 WITHIN the slice; the returned audit map is keyed by that
 *   same index. Indexing the full stored array (the original port) selected the
 *   wrong element on any multi-language component.
 * - `lang` IS REQUIRED and `result` IS THE MAP. PHP rejects a missing lang
 *   (`empty($lang)`) instead of addressing a slice the caller never named, and
 *   returns $ar_replaced whenever the request was well-formed — `false` means
 *   the request FAILED, not "nothing moved".
 *
 * ONE deliberate divergence from PHP: when no element's text actually changes,
 * the write is SKIPPED (PHP saved unconditionally). The response is identical
 * either way, so nothing on the wire depends on it — what it avoids is a Time
 * Machine row and a falsified dd197/dd201 modified stamp for a request that
 * changed nothing. Gated by the "moves nothing returns the MAP, not false" test.
 */

import { readMatrixRecord } from '../../../src/core/db/matrix.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { replaceTimecodes } from '../../../src/core/media/tools/timecode.ts';
import {
	effectiveSaveLang,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../../src/core/ontology/resolver.ts';
import { filterItemsByLang, readComponentItems } from '../../../src/core/resolve/component_data.ts';
import {
	isLangSlicedModel,
	saveComponentData,
} from '../../../src/core/section/record/save_component.ts';
import { authorizeRecordAccess } from '../../../src/core/security/write_door.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

async function changeAllTimecodes(ctx: ToolActionContext): Promise<ToolResponse> {
	// AMBIGUITY IS A DENIAL — HERE TOO (T2-S05-b). The record_tipo gate refuses a
	// payload whose two aliases disagree; the handler refuses it again rather
	// than pick one, so the component it rewrites can never differ from the one a
	// gate authorized, whoever calls it.
	const { tipo, component_tipo: componentTipoAlias } = ctx.options;
	if (tipo != null && componentTipoAlias != null && String(tipo) !== String(componentTipoAlias)) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'tipo and component_tipo name different components',
		});
	}
	const componentTipo = String(tipo ?? componentTipoAlias ?? '');
	const sectionTipo = String(ctx.options.section_tipo ?? '');
	// PHP `empty($lang)` (:127): a bulk rewrite must name the slice it rewrites.
	// Defaulting to lg-nolan silently addressed a DIFFERENT slice than the caller
	// meant — and, since the save writes the slice back whole, could move data.
	const lang = String(ctx.options.lang ?? '');
	const offsetSeconds = Number(ctx.options.offset_seconds ?? 0);
	if (componentTipo === '' || sectionTipo === '' || lang === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'component_tipo, section_tipo, a positive section_id and lang are required',
		});
	}
	if (!Number.isFinite(offsetSeconds)) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'offset_seconds must be a number',
		});
	}
	// THE HANDLER IS ITS OWN DOOR (T2-S05-b): the write door on the one
	// (section, component, record) it rewrites — grammar (a non-positive or
	// malformed id refused), section floor 1, the dd128-aware pair at 2, the
	// write scope — and the GRANT addresses the read and the save below. The
	// declarative record_tipo gate asked the same; asking here makes "the pair
	// written is the pair authorized" a property of the handler, measured by the
	// authorization matrix running it (tool:tool_tc:change_all_timecodes:handler).
	const grant = await authorizeRecordAccess(
		ctx.principal,
		{
			section_tipo: sectionTipo,
			component_tipo: componentTipo,
			section_id: ctx.options.section_id,
		},
		{ mode: 'write', level: 2, sectionFloor: 1, door: 'tool_tc.change_all_timecodes' },
	);
	const sectionId = grant.sectionId;

	const model = await getModelByTipo(componentTipo);
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (model === null || table === null) {
		throw new DedaloError('request.invalid_tipo', {
			coordinates: { tipo: componentTipo, section_tipo: sectionTipo },
		});
	}
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	if (record === null) {
		throw new DedaloError('tool.target_not_found', {
			coordinates: { section_tipo: sectionTipo, section_id: sectionId },
			message: 'record not found',
		});
	}
	const storedItems = (readComponentItems(record, componentTipo, model) ?? []) as {
		id?: number | string;
		lang?: string;
		value?: unknown;
	}[];

	// PHP get_data_lang (:1297-1333): supports_translation === false returns the
	// FULL array; otherwise the lang slice, RE-INDEXED by array_values. The slice
	// predicate is the WRITE engine's own (isLangSlicedModel + the effective-lang
	// rule) rather than a second copy: read and write must address the same slice,
	// or the save would relocate the items it just read.
	const langSliced = isLangSlicedModel(model);
	const effectiveLang = await effectiveSaveLang(componentTipo, model, lang);
	const slice = langSliced ? filterItemsByLang(storedItems, effectiveLang) : storedItems;

	// Optional single-key filter (PHP `is_null($key) || $key == $raw_key`), else
	// every element of the slice. The rebuilt slice always carries EVERY element
	// — filtered-out ones keep their original text (PHP clones them verbatim into
	// $new_data), because the write replaces the slice whole.
	const keyFilter = ctx.options.key;
	const changesByKey: Record<string, Record<string, string>> = {};
	const newSlice: unknown[] = [];
	let changedCount = 0;
	for (let rawKey = 0; rawKey < slice.length; rawKey++) {
		const item = slice[rawKey] as { value?: unknown } | undefined;
		if (item === undefined) continue; // noUncheckedIndexedAccess: sparse slot
		if (keyFilter != null && String(keyFilter) !== String(rawKey)) {
			newSlice.push(item);
			continue;
		}
		const rawValue = typeof item.value === 'string' ? item.value : '';
		const { text, changes } = replaceTimecodes(rawValue, offsetSeconds);
		changesByKey[String(rawKey)] = changes;
		if (text !== rawValue && item !== null && typeof item === 'object') {
			newSlice.push({ ...item, value: text });
			changedCount += 1;
		} else {
			newSlice.push(item);
		}
	}

	if (changedCount > 0) {
		// ONE save for the whole set (PHP set_data_lang + save): 'set_data' is the
		// write engine's bulk-replace, LANG-SLICED for the translation-supporting
		// literal classes exactly like set_data_lang — sibling languages survive,
		// and the data write + TM row land in a single transaction.
		const saved = await saveComponentData({
			componentTipo: grant.componentTipo,
			sectionTipo: grant.sectionTipo,
			sectionId: grant.sectionId,
			lang,
			changedData: [{ action: 'set_data', value: newSlice }],
			userId: grant.userId,
		});
		if (!saved.ok) {
			throw new DedaloError('record.save_failed', {
				coordinates: { tipo: componentTipo, section_tipo: sectionTipo, section_id: sectionId },
				message: saved.message,
			});
		}
	}

	// `changed` was only ever legible inside the legacy `msg` prose; it is a
	// fact of the payload, so it travels with the per-key change map.
	return ok({ changes: changesByKey, changed: changedCount }, { requestId: toolRequestId(ctx) });
}

export const tool: ToolServerModule = {
	name: 'tool_tc',
	apiActions: {
		change_all_timecodes: { permission: 'record_tipo', minLevel: 2, handler: changeAllTimecodes },
	},
};
