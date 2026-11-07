/**
 * Find ONE stored map source by id — the read half of the contract the tile
 * proxy stands on. The proxy request names `{section_tipo, section_id,
 * component_tipo, source_id}`; once its gates pass (session, section, component,
 * record scope) it reads the component's stored items and asks THIS module for
 * the source. It never receives a URL from the client, and it never trusts a
 * stored one either: the source is re-validated here, at fetch time, with the
 * same validator the save gate ran (a stored template can predate a rule that
 * has since tightened).
 *
 * Three outcomes, because the caller needs the difference even when it shows the
 * client only one of them (unknown and forbidden ids answer alike, by design):
 *   found    the source, valid now, with its id;
 *   absent   no stored source carries that id (or the id is not an id);
 *   invalid  it exists but fails today's validator — the reason is for the log.
 *
 * Pure: it reads the items it is handed.
 */

import { isRecord } from './checked.ts';
import { type MapSource, validateMapSource } from './map_source.ts';

export type StoredSourceLookup =
	| { readonly status: 'found'; readonly source: MapSource }
	| { readonly status: 'absent' }
	| { readonly status: 'invalid'; readonly reason: string };

/** The stored source with `sourceId` among the entries of a component value, raw. */
function findRawSource(items: unknown, sourceId: number): unknown {
	if (!Array.isArray(items)) return undefined;
	for (const entry of items) {
		if (!isRecord(entry) || !Array.isArray(entry.sources)) continue;
		const match = entry.sources.find((source) => isRecord(source) && source.id === sourceId);
		if (match !== undefined) return match;
	}
	return undefined;
}

export function lookupStoredMapSource(items: unknown, sourceId: unknown): StoredSourceLookup {
	if (typeof sourceId !== 'number' || !Number.isSafeInteger(sourceId) || sourceId < 1) {
		return { status: 'absent' };
	}
	const raw = findRawSource(items, sourceId);
	if (raw === undefined) return { status: 'absent' };
	const checked = validateMapSource(raw, 'source');
	if (!checked.ok) return { status: 'invalid', reason: checked.reason };
	return { status: 'found', source: { ...checked.value, id: sourceId } as MapSource };
}
