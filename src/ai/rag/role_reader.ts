/**
 * The characterizer's metadata reader (reference `src/ai/rag2/src/role_reader.ts`,
 * Brick 5). Reads a neighbour's role value and classifies it: a date component
 * becomes an ordinal-seconds range (for ordering periods), everything else a
 * categorical label. READ-ONLY.
 *
 * The two families need DIFFERENT readers, and conflating them was a live bug
 * (2026-07-28). component_date stores structured `{start, end}` objects in the
 * `date` column — they carry no `.value`, so `readComponentText` flattens them
 * to '' and the date branch was unreachable: every date role silently produced
 * nothing. Dates are therefore read from their raw stored items here, and the
 * ordinal comes from the engine's canonical virtual-calendar seconds
 * (`ddDateToSeconds`, the same scale search and audit dates use) rather than a
 * private surrogate — the previous local scale was on its own axis and could
 * never be compared against anything else in the engine.
 */

import { dateItemToValue } from '../../core/components/component_date/date_value.ts';
import { readMatrixRecord } from '../../core/db/matrix.ts';
import { type DdDate, ddDateToSeconds } from '../../core/media/file_date.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../core/ontology/resolver.ts';
import { resolveComponentValue, shownItems } from '../../core/resolve/component_data.ts';
import type { RoleReader } from './characterizer.ts';
import { readComponentText } from './component_text.ts';

/** A stored component_date item: `{id, start?, end?}` (sparse dd_date parts). */
interface DateItem {
	start?: DdDate;
	end?: DdDate;
}

/** A dd_date part is usable for ordering only once it carries a year. */
function usableDate(part: DdDate | undefined): DdDate | null {
	if (part === null || part === undefined || typeof part !== 'object') return null;
	return typeof part.year === 'number' ? part : null;
}

/**
 * Widest span across a date component's items: earliest `start`, latest `end`
 * (an item with no `end` is a point, so its start closes it). Returns null when
 * no item carries a year — the role is then simply absent from the proposal,
 * never a junk 0-seconds range.
 */
export function spanOfDateItems(
	items: readonly unknown[],
): { from: number; to: number; label: string } | null {
	let from: number | null = null;
	let to: number | null = null;
	const labels: string[] = [];

	for (const raw of items) {
		if (raw === null || typeof raw !== 'object') continue;
		const item = raw as DateItem;
		const start = usableDate(item.start);
		if (start === null) continue;
		const end = usableDate(item.end);
		const startSeconds = ddDateToSeconds(start);
		const endSeconds = end === null ? startSeconds : ddDateToSeconds(end);
		from = from === null ? startSeconds : Math.min(from, startSeconds);
		to = to === null ? endSeconds : Math.max(to, endSeconds);
		// The label is human evidence, so it is derived from the STORED shape
		// rather than the ontology's date_mode: a component configured 'date'
		// that nonetheless holds an end date should still show its range.
		const label = dateItemToValue(raw as Record<string, unknown>, end === null ? 'date' : 'range');
		if (label !== '') labels.push(label);
	}

	if (from === null || to === null) return null;
	return { from, to, label: labels.join(' | ') };
}

/** Read a date role from its raw stored items (never through the text path). */
async function readDateRole(input: {
	matrixTable: string;
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	lang: string;
}): Promise<{ kind: 'date'; from: number; to: number; label: string } | null> {
	const record = await readMatrixRecord(input.matrixTable, input.sectionTipo, input.sectionId);
	if (record === null) return null;
	const resolved = await resolveComponentValue(
		record,
		input.componentTipo,
		'component_date',
		input.lang,
	);
	const items = shownItems(resolved);
	if (items === null || items.length === 0) return null;
	const span = spanOfDateItems(items);
	return span === null ? null : { kind: 'date', ...span };
}

/**
 * Build the production RoleReader over this branch's resolver + get_value. Reads
 * the neighbour's component text in the first data lang (or nolan). A date model
 * yields an ordinal range; anything else a categorical label. Soft failures → null.
 */
export function buildRoleReader(langs: readonly string[], nolan: string): RoleReader {
	const lang = langs[0] ?? nolan;
	return async (_role, componentTipo, neighbour) => {
		try {
			const model = await getModelByTipo(componentTipo);
			if (model === null) return null;
			const matrixTable = (await getMatrixTableFromTipo(neighbour.sectionTipo)) ?? 'matrix';
			if (model === 'component_date') {
				return await readDateRole({
					matrixTable,
					componentTipo,
					sectionTipo: neighbour.sectionTipo,
					sectionId: neighbour.sectionId,
					lang,
				});
			}
			const text = await readComponentText({
				matrixTable,
				componentTipo,
				model,
				sectionTipo: neighbour.sectionTipo,
				sectionId: neighbour.sectionId,
				lang,
			});
			if (text === '') return null;
			return { kind: 'categorical', value: text };
		} catch {
			return null;
		}
	};
}
