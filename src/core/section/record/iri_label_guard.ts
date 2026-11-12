/**
 * THE IRI LABEL LAW OF THE SAVE DOOR (T0-12 §3.6, owner decision D1 = refuse loudly).
 *
 * A component_iri item is `{id, lang, iri, title?}`; its human LABEL is not a
 * field of the item — it lives in the paired dd560 dataframe frame
 * (`{type:'dd490', section_tipo:'dd1706', section_id:<label record>, id_key:<item id>}`).
 * PHP's `import_save` turned an import's `label_id` into that frame and STRIPPED
 * the key, so a PHP-era matrix never holds it. The TS importer passed it through
 * verbatim for a while (T0-12 OX2): the item stored a stray `label_id` that no
 * reader consults and no frame was written — a label silently lost.
 *
 * The law: the save door REFUSES (`request.invalid`, the component and the
 * offending item named) any value-carrying change to a model storing the `iri`
 * column whose item carries a `label_id` key — whatever its value, null
 * included: the key itself is the stray. Before the transaction opens, so a
 * refusal writes nothing, raises no counter and leaves no Time Machine row.
 * Every door funnels through saveComponentData — the client API, MCP, the agent
 * change-plan, the CSV/JSON importers (set_data and appendImport alike) — so
 * this one check covers them all; a door that legitimately receives a label id
 * converts it into the dd560 frame THERE, never here.
 *
 * Deliberately NOT judged: the deprecated `title` key (decision D5 — kept and
 * stored as today, PHP parity, its removal is a community decision).
 *
 * Keyed on the descriptor's `column` (getColumnNameByModel), not on a model
 * string: whatever model stores items in the `iri` column is bound by the law.
 *
 * Pure: the answer depends only on the column and the incoming changes.
 */

/** The matrix column whose items this law binds (component_iri's descriptor `column`). */
const IRI_COLUMN = 'iri';

/** The forbidden item key: the label's record id belongs in the dd560 frame. */
const STRAY_LABEL_KEY = 'label_id';

/** The actions whose `value` is ONE item (the same split as value_shape.ts). */
const ITEM_ACTIONS: ReadonlySet<string> = new Set(['insert', 'update']);

/** The slice of a change this law reads. */
interface LabelCheckedChange {
	action: string;
	value: unknown;
}

/** True when `item` is an object carrying the stray `label_id` key. */
function carriesLabelId(item: unknown): boolean {
	return (
		item !== null &&
		typeof item === 'object' &&
		!Array.isArray(item) &&
		Object.hasOwn(item, STRAY_LABEL_KEY)
	);
}

/** The items a change carries: one for insert/update, the array for set_data, none otherwise. */
function itemsOf(change: LabelCheckedChange): readonly unknown[] {
	if (ITEM_ACTIONS.has(change.action)) return [change.value];
	if (change.action === 'set_data' && Array.isArray(change.value)) return change.value;
	return [];
}

/** A compact, bounded echo of the offending item for the refusal message. */
function describeItem(item: unknown): string {
	const text = JSON.stringify(item) ?? String(item);
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * The refusal message for the first iri item carrying `label_id`, or null when
 * the column is not `iri` or no incoming item carries the key. The message names
 * the change, the item position and the item itself, and says where the label
 * belongs instead.
 */
export function iriLabelIdRefusal(
	column: string | null,
	changedData: readonly LabelCheckedChange[],
): string | null {
	if (column !== IRI_COLUMN) return null;
	for (const [index, change] of changedData.entries()) {
		for (const [position, item] of itemsOf(change).entries()) {
			if (!carriesLabelId(item)) continue;
			return (
				`changed_data[${index}] (${String(change.action)}) item ${position} ${describeItem(item)} ` +
				`carries '${STRAY_LABEL_KEY}': an IRI item never stores its label — the label is a ` +
				`dd560 dataframe frame (dd490 → dd1706) paired to the item by id_key. ` +
				`Send the item without '${STRAY_LABEL_KEY}' and save the label as its dd560 frame.`
			);
		}
	}
	return null;
}
