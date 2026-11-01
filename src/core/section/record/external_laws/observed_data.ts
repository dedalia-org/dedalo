/**
 * SUB-LAW (a) — SET OBSERVED DATA (PHP set_data_external, frozen
 * class.component_relation_common.php:1793-1846): the mirror is derived from
 * ANOTHER component of the SAME record — the first `set_observed_data` ddo.
 *
 *   fn 'get_locators_of_tags' — the locators inside the ddo TEXT's tags (a
 *       coin legend's svg symbols: numisdata195 → numisdata563; the suite twin
 *       test6263 → test6380). PHP class.component_text_area.php:295-330.
 *   fn 'copy' — PHP's no-`perform` branch (:1828): the ddo's own relation bag
 *       copied verbatim. No shipped or fixture node uses it; ported, not
 *       refused (owner ruling 2026-10-30), and only for a RELATION ddo — a
 *       literal component's {id,lang,value} items are not locators.
 *
 * THE LANG RULE (owner ruling Q4, a WC-ledgered divergence): PHP read only
 * `data[0].value` of the data lang (DEDALO_DATA_LANG for a translatable ddo),
 * so the stored mirror depended on WHO saved last. The mirror is
 * lang-agnostic relation data, so TS reads the UNION of every stored lang, in
 * a fixed lang order — lg-nolan, then the main data lang
 * (config.lang.dataLangDefault), then the remaining langs sorted — and, within
 * one text, DOCUMENT order (the order the user wrote or arranged the symbols
 * in). Dedup is first occurrence. The live legends are stored lg-nolan
 * (numisdata195 on numisdata41/4732), so the union equals PHP's read there.
 *
 * THE GONE-RECORD RULE (the same rule as source_overwrite's dangling pointer):
 * a tag whose record no longer exists contributes nothing. The delete door
 * strips the deleted record's locator from every relation slot, this one
 * included, but leaves the text (and its tag) alone — without the rule the
 * next recompute (a text save, a refresh, a reconcile) wrote the dead locator
 * back. Existence is read in ONE query per target table (no per-tag round
 * trip), FOR SHARE under the kernel's lock (the target row is locked first —
 * the order), so a concurrent delete waits for the recompute's COMMIT and then
 * strips. A tag naming a section with no matrix table is unanswerable — a
 * defect (drops withheld), never silently "gone". `copy` is untouched: its
 * input is a relation bag, which the delete door strips itself.
 *
 * The order is part of the value (merge order 'desired'; these portals are
 * `source.mode` external, never user-sortable). No freeze (PHP had none).
 * A missing ddo node, or a ddo of the wrong storage for its function, is a
 * DEFECT (the law is unanswerable → the kernel withholds drops); an empty
 * text is simply `[]`. `dependencies()` is `[]` (critique 11): the self edge
 * on the ddo is already declared in `observe`.
 */

import { config } from '../../../../config/config.ts';
import { incrementCounter } from '../../../api/counters.ts';
import {
	extractTagLocators,
	type TagLocator,
} from '../../../components/component_text_area/tag_grammar.ts';
import { sql } from '../../../db/postgres.ts';
import { getMatrixTableFromTipo, getModelByTipo, getNode } from '../../../ontology/resolver.ts';
import type {
	CandidateScope,
	DesiredLocator,
	ExternalValueLaw,
	LawComputeContext,
	LawComputeResult,
	ObservedDataLaw,
	StoredLocator,
} from './types.ts';

/** The no-lang lang (relation data, untranslatable literals). */
const NOLAN = 'lg-nolan';

/**
 * The fixed lang order of the union (see the header): lg-nolan, the main data
 * lang, the rest sorted by code point. Deduplicated; pure.
 */
export function orderTextLangs(langs: readonly string[], mainLang: string): string[] {
	const present = [...new Set(langs)];
	const head = [NOLAN, mainLang].filter(
		(lang, at, list) => present.includes(lang) && list.indexOf(lang) === at,
	);
	const rest = present.filter((lang) => !head.includes(lang)).sort();
	return [...head, ...rest];
}

/** One stored text item (component_text_area's `string` column shape). */
export interface StoredTextItem {
	lang?: unknown;
	value?: unknown;
}

/**
 * The tag locators across every stored lang of one text (pure): langs in
 * orderTextLangs order, items of a lang in stored order, each text in
 * document order, first occurrence wins (key-order-independent identity, like
 * extractTagLocators within one text). An item without a string lang reads
 * as lg-nolan; a non-string value holds no tags.
 */
export function tagLocatorsAcrossLangs(
	items: readonly StoredTextItem[],
	tags: readonly string[],
	mainLang: string,
): TagLocator[] {
	const langOf = (item: StoredTextItem): string =>
		typeof item.lang === 'string' && item.lang !== '' ? item.lang : NOLAN;
	const textItems = items.filter((item) => item !== null && typeof item === 'object');
	const locators: TagLocator[] = [];
	const seen: string[] = [];
	for (const lang of orderTextLangs(textItems.map(langOf), mainLang)) {
		for (const item of textItems) {
			if (langOf(item) !== lang || typeof item.value !== 'string') continue;
			appendNewLocators(locators, seen, extractTagLocators(item.value, tags));
		}
	}
	return locators;
}

/** Appends each locator not seen yet (key-order-independent identity), in place. */
function appendNewLocators(
	locators: TagLocator[],
	seen: string[],
	extracted: readonly TagLocator[],
): void {
	for (const locator of extracted) {
		const identity = JSON.stringify(
			Object.keys(locator)
				.sort()
				.map((key) => [key, locator[key]]),
		);
		if (seen.includes(identity)) continue;
		seen.push(identity);
		locators.push(locator);
	}
}

/** The storage the ddo must have for the law's function. */
function requiredColumn(law: ObservedDataLaw): 'string' | 'relation' {
	return law.fn === 'copy' ? 'relation' : 'string';
}

/**
 * The ddo's storage column, or the defect that makes the law unanswerable.
 * The component registry is loaded first: getModelByTipo's alias resolution
 * needs its lookup registered (standalone scripts — the reconciler — reach
 * here without the server's preload).
 */
async function ddoColumn(law: ObservedDataLaw): Promise<{ column: string } | { defect: string }> {
	if ((await getNode(law.ddoTipo)) === null) {
		return { defect: `observed_data_node_missing:${law.ddoTipo}` };
	}
	const { getComponentModel } = await import('../../../components/registry.ts');
	const model = await getModelByTipo(law.ddoTipo);
	const column = model === null ? undefined : getComponentModel(model)?.column;
	if (column !== requiredColumn(law)) {
		return {
			defect: `observed_data_storage_mismatch:${law.ddoTipo}:${String(column)}≠${requiredColumn(law)}`,
		};
	}
	return { column };
}

/** The target row as the law reads it: the mirror, its index and the ddo's value. */
interface ObservedDataRow {
	bag: StoredLocator[] | null;
	idx: unknown;
	src: unknown;
}

/**
 * The source component lives on the SAME row: one read, one lock. The column
 * name is one of two literals (requiredColumn), never ontology text; an
 * unanswerable ddo reads no source at all.
 */
async function readObservedDataRow(
	law: ObservedDataLaw,
	context: LawComputeContext,
	readsSource: boolean,
): Promise<ObservedDataRow | undefined> {
	const { targetSection, targetId, table, lock } = context;
	const sourceSelect = readsSource ? `"${requiredColumn(law)}"->$4` : 'NULL';
	const params = [targetSection, targetId, law.observerTipo];
	if (readsSource) params.push(law.ddoTipo);
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS bag, relation_search->$3 AS idx, ${sourceSelect} AS src FROM "${table}" WHERE section_tipo = $1 AND section_id = $2${lock ? ' FOR UPDATE' : ''}`,
		params,
	)) as ObservedDataRow[];
	return rows[0];
}

/** The desired set from the ddo's stored value: its relation bag (copy) or its tag locators. */
function desiredFromSource(law: ObservedDataLaw, source: unknown): DesiredLocator[] {
	const items = Array.isArray(source) ? source : [];
	if (law.fn === 'copy') {
		return items.filter((item) => item !== null && typeof item === 'object') as DesiredLocator[];
	}
	return tagLocatorsAcrossLangs(
		items as StoredTextItem[],
		law.tags,
		config.lang.dataLangDefault,
	) as unknown as DesiredLocator[];
}

/** A section tipo safe to inline in a Postgres array literal (a resolved ontology tipo). */
const ARRAY_SAFE_TIPO = /^[a-z][a-z0-9_]*$/i;

/** The existence key of one record: `section_tipo|section_id`. */
function recordKey(sectionTipo: unknown, sectionId: unknown): string {
	return `${String(sectionTipo)}|${Number(sectionId)}`;
}

/** The section tipos and ids to probe in one matrix table. */
interface TableProbe {
	tipos: Set<string>;
	ids: Set<number>;
}

/**
 * The matrix table a tag locator's section lives in; `null` when the tipo is
 * unsafe to inline in an array literal (no resolved table can have one) or
 * resolves to no table.
 */
async function locatorTable(sectionTipo: string): Promise<string | null> {
	if (!ARRAY_SAFE_TIPO.test(sectionTipo)) return null;
	return await getMatrixTableFromTipo(sectionTipo);
}

/**
 * Groups the locators by target table (one existence query per table). Every
 * section whose table does not resolve is a defect, recorded once each.
 */
async function groupLocatorsByTable(
	locators: readonly DesiredLocator[],
): Promise<{ byTable: Map<string, TableProbe>; defects: string[] }> {
	const byTable = new Map<string, TableProbe>();
	const defects: string[] = [];
	for (const locator of locators) {
		const sectionTipo = String(locator.section_tipo);
		const table = await locatorTable(sectionTipo);
		if (table === null) {
			const defect = `observed_data_tag_table_unresolved:${sectionTipo}`;
			if (!defects.includes(defect)) defects.push(defect);
			continue;
		}
		const group = byTable.get(table) ?? { tipos: new Set<string>(), ids: new Set<number>() };
		group.tipos.add(sectionTipo);
		group.ids.add(Number(locator.section_id));
		byTable.set(table, group);
	}
	return { byTable, defects };
}

/**
 * The existence keys (recordKey) of the probed records present in one table.
 * Non-integer ids can match no row and are left out; `lock` takes FOR SHARE on
 * the rows found (a concurrent delete waits for the recompute's COMMIT).
 */
async function existingKeysInTable(
	table: string,
	{ tipos, ids }: TableProbe,
	lock: boolean,
): Promise<string[]> {
	const intIds = [...ids].filter((id) => Number.isSafeInteger(id));
	if (intIds.length === 0) return [];
	const rows = (await sql.unsafe(
		`SELECT section_tipo, section_id FROM "${table}"
		 WHERE section_tipo = ANY($1::text[]) AND section_id = ANY($2::int[])
		 ORDER BY section_tipo, section_id${lock ? ' FOR SHARE' : ''}`,
		[`{${[...tipos].join(',')}}`, `{${intIds.join(',')}}`],
	)) as { section_tipo: string; section_id: number }[];
	return rows.map((row) => recordKey(row.section_tipo, row.section_id));
}

/**
 * The GONE-RECORD RULE (see the header): keeps the tag locators whose record
 * exists, in order. One existence query per target table; a section without a
 * matrix table (or an unsafe tipo, which no resolved table can have) makes the
 * whole answer a defect.
 */
async function keepExistingRecords(
	locators: readonly DesiredLocator[],
	lock: boolean,
): Promise<{ kept: DesiredLocator[]; defects: string[] }> {
	const { byTable, defects } = await groupLocatorsByTable(locators);
	if (defects.length > 0) return { kept: [], defects };
	const existing = new Set<string>();
	for (const [table, probe] of byTable) {
		for (const key of await existingKeysInTable(table, probe, lock)) existing.add(key);
	}
	return {
		kept: locators.filter((locator) =>
			existing.has(recordKey(locator.section_tipo, locator.section_id)),
		),
		defects: [],
	};
}

async function computeObservedData(
	law: ObservedDataLaw,
	context: LawComputeContext,
): Promise<LawComputeResult> {
	const { targetSection, targetId } = context;
	const { getRelationTypeByTipo } = await import('../../../relations/save.ts');
	const base = {
		order: 'desired' as const,
		fallbackType: await getRelationTypeByTipo(law.observerTipo),
		dropSelf: true,
		freeze: false,
	};
	const storage = await ddoColumn(law);
	const row = await readObservedDataRow(law, context, 'column' in storage);
	if (row === undefined) {
		return {
			...base,
			exists: false,
			existing: [],
			storedIndex: null,
			desired: [],
			referenceCount: 0,
			defects: [],
		};
	}
	const answer = (desired: DesiredLocator[], defects: string[] = []): LawComputeResult => ({
		...base,
		exists: true,
		existing: row.bag ?? [],
		storedIndex: row.idx ?? null,
		desired,
		referenceCount: desired.length,
		defects,
	});
	if ('defect' in storage) {
		console.error(
			`observer '${law.observerTipo}' @ ${targetSection}/${targetId}: set_observed_data ddo unanswerable (${storage.defect}) — drops withheld`,
		);
		incrementCounter('observers_observed_data_unanswerable');
		return answer([], [storage.defect]);
	}
	const desired = desiredFromSource(law, row.src);
	if (law.fn === 'copy' || desired.length === 0) return answer(desired);
	const { kept, defects } = await keepExistingRecords(desired, context.lock);
	if (defects.length > 0) {
		console.error(
			`observer '${law.observerTipo}' @ ${targetSection}/${targetId}: a tag names a section without a matrix table (${defects.join(', ')}) — drops withheld`,
		);
		incrementCounter('observers_observed_data_unanswerable');
	}
	return answer(kept, defects);
}

/**
 * The reconciler's candidates at one host section: the records holding the
 * mirror ∪ the records whose ddo column carries the ddo. A section that does
 * not declare the observer holds no candidate (the host predicate).
 */
async function observedDataCandidateIds(
	law: ObservedDataLaw,
	scope: CandidateScope,
	hostTable: string,
	onlyId: number | null,
): Promise<number[]> {
	const { isObserverHostSection } = await import('./resolvers.ts');
	if (!(await isObserverHostSection(scope.observerTipo, scope.hostSection))) return [];
	const rows = (await sql.unsafe(
		`SELECT section_id AS id FROM "${hostTable}"
		 WHERE section_tipo = $1 AND (relation ? $2 OR "${requiredColumn(law)}" ? $3)`,
		[scope.hostSection, scope.observerTipo, law.ddoTipo],
	)) as { id: number }[];
	const ids = new Set(rows.map((row) => Number(row.id)));
	if (onlyId !== null) return ids.has(onlyId) ? [onlyId] : [];
	return [...ids].sort((a, b) => a - b);
}

export const observedDataLaw: ExternalValueLaw<ObservedDataLaw> = Object.freeze({
	kind: 'observed_data' as const,
	compute: computeObservedData,
	dependencies: () => [],
	pointer: () => undefined,
	candidateIds: observedDataCandidateIds,
});
