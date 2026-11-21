/**
 * Data-item EMPTINESS — the one home of "does this item / this lang slice carry
 * a value?" for the class-translatable (literal) models: the question the
 * language fallback asks (T1-34 / O14). An item COUNT is not the answer — a
 * cleared translation is persisted as `{id, lang, value: ''}` (the save keeps
 * the item, so its id stays paired with the editor and the dataframes), and a
 * rich-text editor leaves `<p></p>` behind. Those slices hold items and no value.
 * The WRITE asks the same question of the whole value (T2-SL-4,
 * save_component.ts literal collapse): when EVERY language is empty the key is
 * stored as absent — a husk slice survives only beside a language that holds a
 * value (and in records written before the collapse existed).
 *
 * Each model DECLARES its rule (descriptor `dataItemEmptiness`; every
 * classSupportsTranslation model must — descriptor_completeness_tripwire):
 *   - 'common'    : value missing / null / '' / false / [] → empty; '0' and 0
 *                   are values; no trim (PHP component_common::is_empty).
 *   - 'string'    : the common rule after trimming a string value
 *                   (PHP component_string_common::is_empty).
 *   - 'rich_text' : the string rule + the editor's ghost markup `<p></p>`,
 *                   `<p> </p>`, `<br data-mce-bogus="1">` after trim
 *                   (PHP component_text_area::is_empty). No other tag is
 *                   stripped: `<b></b>` stays a value.
 *   - 'iri'       : blank `iri` AND blank `title` (PHP component_iri::is_empty).
 *                   NOT the CSV append identity (append_merge isEmptyLiteralItem)
 *                   — a different question that happens to look alike.
 *
 * Pure: no I/O, no module state.
 */

import { getComponentModel } from '../components/registry.ts';
import type { DataItemEmptinessRule } from '../components/types.ts';
import { DedaloError } from '../errors/dedalo_error.ts';

/** Editor ghost markup a rich-text model counts as "no text" (after trim). */
const RICH_TEXT_GHOSTS: ReadonlySet<string> = new Set([
	'<p></p>',
	'<p> </p>',
	'<br data-mce-bogus="1">',
]);

/** PHP `empty()` with the zero carve-out ('0', 0 are values). */
function isBlankScalar(value: unknown): boolean {
	if (value === undefined || value === null || value === '' || value === false) return true;
	return Array.isArray(value) && value.length === 0;
}

function trimmed(value: unknown): unknown {
	return typeof value === 'string' ? value.trim() : value;
}

type ItemFields = { value?: unknown; iri?: unknown; title?: unknown };

/** The rich-text rule: the string rule + the editor's ghost markup. */
function isEmptyRichText(item: ItemFields): boolean {
	const value = trimmed(item.value);
	return isBlankScalar(value) || (typeof value === 'string' && RICH_TEXT_GHOSTS.has(value));
}

/** One predicate per rule — the PHP is_empty override of each class. */
const RULE_PREDICATES: Readonly<Record<DataItemEmptinessRule, (item: ItemFields) => boolean>> = {
	common: (item) => isBlankScalar(item.value),
	string: (item) => isBlankScalar(trimmed(item.value)),
	rich_text: isEmptyRichText,
	iri: (item) => isBlankScalar(item.iri) && isBlankScalar(item.title),
};

/** Whether one stored data item carries no value under `rule`. */
export function isEmptyDataItem(rule: DataItemEmptinessRule, item: unknown): boolean {
	if (item === null || typeof item !== 'object' || Array.isArray(item)) return true;
	return RULE_PREDICATES[rule](item as ItemFields);
}

/** The fields each rule reads — where an item of that rule HOLDS its value. */
const RULE_VALUE_FIELDS: Readonly<Record<DataItemEmptinessRule, readonly string[]>> = {
	common: ['value'],
	string: ['value'],
	rich_text: ['value'],
	iri: ['iri', 'title'],
};

/** The keys every literal item carries beside its value: identity, never a value. */
const ITEM_IDENTITY_KEYS: ReadonlySet<string> = new Set(['id', 'lang']);

/**
 * An item that CARRIES something yet holds it in NONE of the rule's value
 * fields (B3 review M2, owner ruling 2026-11-21): a locator sent to an
 * input_text / text_area, a `{value}` item sent to a component_iri. The rule
 * above judges such an item empty — so a save of it would collapse to absent
 * and answer ok with nothing written; the save door REFUSES it instead
 * (save_component.ts fieldlessValueRefusal). "Carries something" = a
 * non-scalar-blank field beyond the item's identity (`id`, `lang`), or a
 * non-blank bare scalar. An item that names a value field — even null / '' —
 * or carries only its identity is a genuine empty and is NOT this.
 */
export function isFieldlessValueItem(rule: DataItemEmptinessRule, item: unknown): boolean {
	if (item === null || item === undefined) return false;
	if (typeof item !== 'object' || Array.isArray(item)) return !isBlankScalar(item);
	if (RULE_VALUE_FIELDS[rule].some((field) => Object.hasOwn(item, field))) return false;
	return Object.entries(item).some(
		([key, value]) => !ITEM_IDENTITY_KEYS.has(key) && !isBlankScalar(value),
	);
}

/** The declared emptiness rule of a model; loud when it declares none. */
export function dataItemEmptinessOf(model: string): DataItemEmptinessRule {
	const rule = getComponentModel(model)?.dataItemEmptiness;
	if (rule === undefined) {
		// Unreachable for every class-translatable model (tripwired); a caller
		// asking about any other model asked the wrong question.
		throw new DedaloError('internal.invariant', {
			message: `data_item_emptiness: model '${model}' declares no dataItemEmptiness rule`,
			coordinates: { module: 'core/resolve/data_item_emptiness.ts', model },
		});
	}
	return rule;
}

/**
 * PHP is_empty_data: true when `items` is null or EVERY item is empty under
 * the model's rule (an empty array is empty).
 */
export function isEmptyComponentData(model: string, items: readonly unknown[] | null): boolean {
	if (items === null) return true;
	const rule = dataItemEmptinessOf(model);
	return items.every((item) => isEmptyDataItem(rule, item));
}
