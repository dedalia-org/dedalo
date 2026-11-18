/**
 * THE CALL-NUMBER IS THE RECORD'S ADDRESS (owner ruling 2026-11-17).
 *
 * Zotero has no editable id, so the cataloguer who wants a reference to live at
 * a given record writes that record's section_id in the field the config names
 * (`main.field_to_section_id`, default `call-number`). That value is an
 * OPERATOR-CHOSEN ADDRESS — the one named exception to the law that an imported
 * identifier is a code looked up in a component and never a record number
 * (audit DATA-08, src/core/tools/import_code_lookup.ts), for THIS door only.
 * The Zotero KEY keeps that law (`resolveMappedCodes`).
 *
 * The rules, each gated in test/unit/tool_import_zotero_native.test.ts:
 *
 *   1. Only a canonical positive int4 (`recordNumberOf`) is an address. Anything
 *      else refuses THAT item, naming the value (PHP cast it — '12abc' wrote
 *      record 12 — or skipped the item in silence).
 *   2. A record lives at the id → it is UPDATED. If it already holds a Zotero
 *      key that is not the item's → refused (`resource.conflict`): an import
 *      never re-keys a record. No key yet → adopted (the key is written).
 *   3. No record at the id → CREATED there (the engine's explicit-id insert; the
 *      counter rises with GREATEST) — also when the id is free because its
 *      record was DELETED: re-importing after a detected error is legitimate.
 *   4. No call-number on the item → its Zotero key decides, as before.
 *   5. Key and call-number name two different records → refused.
 *   6. One call-number on two items of one run → the SECOND is refused (the
 *      call-number's posture is per item; a duplicated KEY still refuses the run).
 *
 * Rules 1, 5 and 6 are decided here, before any write. Rules 2 and 3 are decided
 * by the executor INSIDE the record's transaction (import_execute.ts
 * `addressedTarget`), on what is true when the record is written — this module
 * hands it the guard (`refusalFor`) and reads the outcome back for the report.
 * The write door and the create permission apply as to any import: a record
 * living at the id that the importer may NOT write refuses the item (`perm.*`)
 * before its key is read — an address reaches any id of the section, the key
 * lookup only the importer's own scope.
 *
 * The executor writes the ADDRESSED items first, highest call-number first
 * (import_execute.ts `writeOrder`): whatever the run allocates — an item without
 * a call-number, a linked record — takes the counter's next id, and must never
 * take one an item of the same export names.
 */

import {
	type ImportCodeTarget,
	readStoredCodesForUpdate,
} from '../../../src/core/tools/import_code_lookup.ts';
import type {
	MappedRecord,
	RecordAddress,
	RecordRefusal,
	RecordResult,
} from '../../../src/core/tools/import_execute.ts';
import { recordNumberOf, type ZoteroMappedRecord } from '../../../src/core/tools/zotero_map.ts';

/**
 * One item the run refused: which, the refusal's code, and its sentence (the
 * operator's own file). `request.invalid_data` (rules 1, 6), `resource.conflict`
 * (rules 2, 5), or the record door's `perm.*` code (a record the importer may
 * not write).
 */
export interface ItemRefusal {
	item: string;
	code: RecordRefusal['code'];
	message: string;
}

/** One item of the batch, past the call-number screen. */
export interface AddressedItem {
	/** Its name in a report line: its Zotero key, else its position in the export. */
	who: string;
	mapped: ZoteroMappedRecord;
	/** The record number its call-number names (null = none: the key decides). */
	address: number | null;
}

/** What the address rules need of the run. */
export interface AddressScope {
	/** The config's `field_to_section_id` variable — named in every sentence. */
	variable: string;
	/** The code component holding the Zotero key (the map's `id` entry). */
	idTarget: ImportCodeTarget | undefined;
	sectionTipo: string;
}

/** The value as a sentence quotes it (a pathological one is cut, never dropped). */
function shown(raw: string): string {
	return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

/** One call-number, judged: the record number (null = none), or why the item is refused. */
function screenAddress(
	raw: string | null,
	variable: string,
	seen: Set<number>,
): { sectionId: number | null } | { refusal: string } {
	if (raw === null) return { sectionId: null };
	const sectionId = recordNumberOf(raw);
	if (sectionId === null) {
		return {
			refusal: `${variable} '${shown(raw)}' is not a record number, so it names no record — the item was not imported. Write the record's section_id there as a whole number (1 to 2147483647, digits only), or clear it to match the reference by its Zotero key.`,
		};
	}
	if (seen.has(sectionId)) {
		return {
			refusal: `${variable} '${sectionId}' is carried by an earlier item of this import, so two items name one record — the item was not imported. Fix the export.`,
		};
	}
	seen.add(sectionId);
	return { sectionId };
}

/**
 * Rules 1 and 6, for the whole batch, before anything is looked up: each item's
 * call-number as a record number. A refused item leaves the batch (its line goes
 * to `refused`); the rest proceed.
 */
export function screenAddresses(
	mapped: readonly ZoteroMappedRecord[],
	variable: string,
	refused: ItemRefusal[],
): AddressedItem[] {
	const kept: AddressedItem[] = [];
	const seen = new Set<number>();
	for (const [index, record] of mapped.entries()) {
		const who = record.code ?? `item #${index + 1}`;
		const screened = screenAddress(record.address, variable, seen);
		if ('refusal' in screened) {
			refused.push({ item: who, code: 'request.invalid_data', message: screened.refusal });
		} else kept.push({ who, mapped: record, address: screened.sectionId });
	}
	return kept;
}

/**
 * Rule 2's guard, asked by the executor inside the record's transaction when a
 * record already lives at the address: its stored key(s), read under the row
 * lock. None → adopt. The item's own key (or its full URI, the other spelling a
 * stored code may hold) → the same reference. Anything else → refused; so is an
 * item that carries NO key against a record that holds one (nothing says it is
 * that reference). The stored value is never quoted: the importer may not be
 * able to read that record.
 */
function keyGuard(item: AddressedItem, scope: AddressScope): RecordAddress['refusalFor'] {
	const own = new Set([item.mapped.code, item.mapped.url].filter((code) => code !== null));
	return async ({ sectionId }) => {
		if (scope.idTarget === undefined) return null;
		const target = { sectionTipo: scope.sectionTipo, componentTipo: scope.idTarget.componentTipo };
		const held = ((await readStoredCodesForUpdate(target, sectionId)) ?? []).filter(
			(code) => code !== '',
		);
		if (held.length === 0 || held.some((code) => own.has(code))) return null;
		return `${scope.variable} '${sectionId}' names record ${sectionId}, which already holds a Zotero key that is not this item's — an import never re-keys a record, so the item was not imported. Correct the ${scope.variable}, or clear that record's code first.`;
	};
}

/** One item's record with its address applied (rule 5), or why it is refused. */
function addressRecord(
	item: AddressedItem,
	byKey: MappedRecord,
	scope: AddressScope,
): { record: MappedRecord } | { refusal: string } {
	if (item.address === null) return { record: byKey };
	if (byKey.sectionId !== null && byKey.sectionId !== item.address) {
		return {
			refusal: `${scope.variable} '${item.address}' names record ${item.address}, but this item's Zotero key is held by record ${byKey.sectionId} — the import cannot tell which record the item means, so it was not imported. Correct the ${scope.variable}, or resolve the two records first.`,
		};
	}
	return {
		record: {
			...byKey,
			sectionId: null,
			address: { sectionId: item.address, refusalFor: keyGuard(item, scope) },
		},
	};
}

/**
 * Rule 5, and the address handed to the executor: `byKey` is the batch as the
 * Zotero KEY resolved it (`resolveMappedCodes`, index-aligned with `items`). An
 * item whose key names another record than its call-number is refused and
 * leaves the batch; one with an address is written AT it.
 */
export function addressRecords(
	items: readonly AddressedItem[],
	byKey: readonly MappedRecord[],
	scope: AddressScope,
	refused: ItemRefusal[],
): { items: AddressedItem[]; records: MappedRecord[] } {
	const kept: { items: AddressedItem[]; records: MappedRecord[] } = { items: [], records: [] };
	for (const [index, item] of items.entries()) {
		const addressed = addressRecord(item, byKey[index] as MappedRecord, scope);
		if ('refusal' in addressed) {
			refused.push({ item: item.who, code: 'resource.conflict', message: addressed.refusal });
			continue;
		}
		kept.items.push(item);
		kept.records.push(addressed.record);
	}
	return kept;
}

/** What the call-number addresses came to (rule 7's report lists). */
export interface AddressOutcome {
	/** Records created AT their call-number id. */
	createdAtId: number[];
	/** Records updated at their call-number id. */
	updatedAtId: number[];
}

/**
 * The run read back: of the items that carried an address, which were created
 * at it, which updated the record there, and which the executor refused when it
 * came to write them (rule 2, or a record the importer may not write — added to
 * `refused`).
 */
export function addressOutcome(
	items: readonly AddressedItem[],
	results: readonly RecordResult[],
	variable: string,
	refused: ItemRefusal[],
): AddressOutcome {
	const outcome: AddressOutcome = { createdAtId: [], updatedAtId: [] };
	for (const result of results) {
		const item = items[result.index];
		if (item === undefined || item.address === null) continue;
		if (result.refusal === undefined) settleAddressed(result, outcome);
		else refused.push(writeRefusal(item, item.address, variable, result.refusal));
	}
	return outcome;
}

/**
 * The executor's refusal as the report's line. The guard's sentence (rule 2) is
 * this door's own; the record door's is said in the operator's terms — and says
 * nothing of what the record holds.
 */
function writeRefusal(
	item: AddressedItem,
	sectionId: number,
	variable: string,
	refusal: RecordRefusal,
): ItemRefusal {
	if (refusal.code === 'resource.conflict') {
		return { item: item.who, code: refusal.code, message: refusal.message };
	}
	return {
		item: item.who,
		code: refusal.code,
		message: `${variable} '${sectionId}' names record ${sectionId}, which you may not edit (${refusal.code}) — the item was not imported. Correct the ${variable}, or ask for access to that record.`,
	};
}

/** One addressed record that was not refused: created at its id, updated there, or rolled back (neither). */
function settleAddressed(result: RecordResult, outcome: AddressOutcome): void {
	if (result.sectionId === null) return;
	(result.created ? outcome.createdAtId : outcome.updatedAtId).push(result.sectionId);
}
