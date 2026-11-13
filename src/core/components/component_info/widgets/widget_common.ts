/**
 * component_info widget FOUNDATION — the shared contract + helpers every
 * info widget builds on (PHP core/widgets/widget_common/class.widget_common.php).
 *
 * A widget is a discipline-owned compute unit (organized by TLD exactly like
 * the PHP tree and the byte-identical client: numisdata/, oh/, dd/, dmm/,
 * mdcat/, calculation, state, test/). The ontology declares them per
 * component_info instance as properties.widgets[] = {widget_name, path, ipo};
 * dispatch is by widget_name through widgets/registry.ts — NEVER by loading
 * code from the ontology-authored path (the TS answer to PHP's
 * include-by-path; `path` is kept as verification data for the client-tree
 * tripwire).
 */

import { compareLocators, type Locator } from '../../../concepts/locator.ts';
import { isMatrixTable, type MatrixRecord } from '../../../db/matrix.ts';
import { memoizedReadMatrixRecord } from '../../../db/record_memo.ts';
import { DedaloError } from '../../../errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../../ontology/resolver.ts';

/** One emitted widget data item (shape is widget-specific; keys ordered as PHP inserts them). */
export type WidgetItem = Record<string, unknown>;

/** One ontology-declared widget slot on a component_info instance. */
export interface WidgetDef {
	widget_name?: string;
	path?: string;
	ipo?: unknown[];
}

export interface WidgetContext {
	sectionTipo: string;
	sectionId: number | string;
	mode: string;
	lang: string;
	/** Session user for user-scoped tool availability; null/undefined → superuser set. */
	userId?: number | null;
	/** Global-admin flag of that user (admins resolve the superuser tool set, PHP parity). */
	isAdmin?: boolean;
	/**
	 * The calculation inputs being computed above this one (`tipo@section/id`
	 * keys, outermost first) — threaded BY ARGUMENT through chained calculation
	 * inputs (components/calculation_data.ts) so a cycle refuses instead of
	 * recursing. Absent at a top-level read.
	 */
	calculationStack?: readonly string[];
}

/**
 * WC-026: normalize the widget entries' matching keys at the EMIT boundary —
 * every top-level widget item carries BOTH `id` and `widget_id` when either
 * is a string. The client widget renders match on `widget_id`
 * (render_get_archive_weights/calculation/state/…); the grid/export builders
 * match on `id`; PHP emits ONE of them per widget class (weights/state live
 * = widget_id, calculation live = id) and the STORED misc values are
 * id-keyed — so stored archives and live calculations render BLANK on the
 * PHP client (verified live 2026-07-10). TS satisfies the client's contract
 * by emitting both. Top-level scalar keys only: media_icons row objects
 * (whose `id` key is a CELL object) and nested shapes are untouched; items
 * without a `widget` tag (the tags widget's leading raw text items) pass
 * through verbatim.
 */
export function normalizeWidgetEntryKeys(items: unknown[]): unknown[] {
	return items.map((entry) => {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
		const item = entry as Record<string, unknown>;
		if (typeof item.widget !== 'string') return entry;
		if (typeof item.id === 'string' && !('widget_id' in item)) {
			return { ...item, widget_id: item.id };
		}
		if (typeof item.widget_id === 'string' && !('id' in item)) {
			return { ...item, id: item.widget_id };
		}
		return entry;
	});
}

/**
 * Is this ONE stored entry a v5-era `component_info` state blob — the shape
 * the pre-widget engine wrote into `misc` and that no renderer can read?
 *
 *   {"id":1,
 *    "state":{"lg-spa":{"dd203_1":[100,0],"dd203_2":[100,0]}},
 *    "value":null,
 *    "section_id":"44","section_tipo":"oh1","component_tipo":"oh23"}
 *
 * POSITIVE identification, deliberately — the predicate names the legacy
 * shape rather than asking "does this look modern?". The four discriminators,
 * all four required:
 *
 *  1. no `widget` / `key` / `widget_id` — the three keys every client widget
 *     renderer selects on (render_list_state.js:114,185; the archive-weights
 *     and calculation renderers). A blob carrying any of them is renderable
 *     and is therefore data, whatever else it holds.
 *  2. `value` is present and NULL — the modern entries always carry a real
 *     value; the v5 blob parked its payload in `state` and left `value` empty.
 *  3. `state` is a non-empty object whose EVERY key is a `lg-` language code
 *     (the v5 per-language state map). This is the shape's signature.
 *  4. the record-identity quartet `id` / `section_id` / `section_tipo` /
 *     `component_tipo` is present and typed as the archive holds it.
 *
 * Live-archive census (read-only, dedalo7_mht, 2026-08-09): every one of the
 * 1365 entries in the 688 affected arrays has EXACTLY the key set
 * {component_tipo,id,section_id,section_tipo,state,value} with
 * id=number, value=null, the other three strings and exactly one `lg-` key —
 * one shape, no variants, and it matches nothing else stored in `misc`
 * (the dd477→dd596 arrays, 20 of them, are `{id,value:{…}}` component_json
 * and are correctly NOT matched).
 */
function isLegacyStateEntry(entry: unknown): boolean {
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
	const item = entry as Record<string, unknown>;
	// 1. anything a renderer can select on is data, not residue
	if ('widget' in item || 'key' in item || 'widget_id' in item) return false;
	// 2. the payload-less value
	if (!('value' in item) || item.value !== null) return false;
	// 4. the record-identity quartet
	if (!('id' in item)) return false;
	if (typeof item.section_tipo !== 'string' || typeof item.component_tipo !== 'string')
		return false;
	if (typeof item.section_id !== 'string' && typeof item.section_id !== 'number') return false;
	// 3. the per-language state map — the shape's signature
	const state = item.state;
	if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
	const langs = Object.keys(state);
	return langs.length > 0 && langs.every((lang) => lang.startsWith('lg-'));
}

/**
 * Is this STORED component_info array entirely v5 residue — i.e. is EVERY
 * entry a legacy state blob (see isLegacyStateEntry)?
 *
 * The fall-through in the emit hook is keyed on THIS, a positive test for the
 * legacy shape, never on a negative test for the modern one
 * (WC-2026-08-09-info-legacy-stored-value-fallthrough). The difference is the
 * never-narrow law: "no entry carries a `widget` tag" also captures every
 * stored shape we have not enumerated, and would discard it — a stored array
 * this engine cannot classify must keep PHP's generic behaviour (stored data
 * wins) instead of being recomputed on the strength of an absence.
 *
 * EVERY entry, therefore, not "any" — an array mixing a legacy blob with
 * anything else is not residue, and the tags widget (whose output legitimately
 * LEADS with the raw text-area items of its source component, no `widget` key
 * — widgets/oh/tags.ts reproduces the PHP $data-reuse quirk) is honoured by
 * discriminator 2 and 3 alone: its raw items carry a real `value` and no
 * `state`, so they are not legacy entries and the array is served.
 *
 * An EMPTY array is not residue: PHP's own `empty($data)` already falls
 * through for it, so it is not a divergence and must not be counted as one.
 */
export function isLegacyStateResidue(items: unknown[]): boolean {
	return items.length > 0 && items.every(isLegacyStateEntry);
}

/**
 * The numisdata FLAG convention (PHP get_archive_weights / get_coins_by_period
 * `'2'`): a yes/no flag component is "set" when its FIRST locator's section_id
 * is 2. Value-based, by the locator law (WC-2026-11-12-numisdata-widgets-locator-law):
 * stored locators are INT since WC-2026-08-10-section-id-int-canonical and
 * legacy string ones survive, so 2, "2" and "02" are all the flag. section_tipo
 * is NOT compared — PHP never did, and the vocabulary section is install-defined.
 */
export const FLAG_SET_SECTION_ID = 2;

/** Whether a flag component's items say "set" (first locator section_id == 2). */
export function isFlagSet(items: readonly unknown[]): boolean {
	return compareLocators(items[0] as Locator, { section_id: FLAG_SET_SECTION_ID } as Locator, [
		'section_id',
	]);
}

/**
 * The registry contract of one widget implementation (PHP <widget> extends
 * widget_common). `name` is the ontology/client identity and the registry
 * key; `path` mirrors the ontology-authored value and locates the CLIENT
 * module (client/dedalo/core/widgets<path>/js/<name>.js) — verified by the
 * registry tripwire, never used for dispatch.
 */
export type InfoWidgetDescriptor =
	| {
			name: string;
			path: string;
			/** PHP is_async() — skipped by the read-time aggregate; delivered via get_widget_data. */
			isAsync?: true;
			computeData(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]>;
			/** PHP get_data_parsed override (grid/export/diffusion); absent → computeData. */
			computeDataParsed?(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]>;
			/** PHP get_data_list (edit-mode datalist; only the state widget implements it). */
			computeDataList?(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]>;
	  }
	| {
			name: string;
			path: string;
			isAsync?: true;
			/**
			 * Registered-but-unported: compute throws WidgetUnportedError. The `reason`
			 * is the never-narrow declaration itself and is tripwired for substance
			 * (info_widget_registry_tripwire) — say WHY the port is missing, right here.
			 */
			unported: { reason: string };
	  };

/**
 * A registered widget whose server compute is not ported yet (a substantive
 * `unported.reason` is required).
 *
 * A thin DedaloError family (ERRORS_SPEC §7): the fixed code is
 * `widget.unported` — the server has no implementation for it, which is a
 * 503 the operator can act on. The declaration sentence stays as
 * `Error.message` (log-only) so the `reason` never reaches the wire.
 */
export class WidgetUnportedError extends DedaloError {
	constructor(name: string, reason: string) {
		super('widget.unported', {
			message: `component_info widget '${name}' is not ported: ${reason}`,
			coordinates: { widget: name },
		});
		this.name = 'WidgetUnportedError';
	}
}

/**
 * An ontology-declared widget_name with no registry entry (PHP fatals on the
 * include). Fixed code `widget.not_defined` — the same code the maintenance
 * widget door already uses for a name nothing answers to.
 */
export class WidgetNotRegisteredError extends DedaloError {
	constructor(name: string) {
		super('widget.not_defined', {
			message: `component_info widget '${name}' is not registered (widgets/registry.ts)`,
			coordinates: { widget: name },
		});
		this.name = 'WidgetNotRegisteredError';
	}
}

/**
 * PHP round(): half away from zero at the given precision (JS Math.round is
 * half-up, which differs for negatives; inputs here are non-negative but the
 * sign handling is kept for fidelity). toPrecision(15) absorbs the binary
 * representation drift PHP's pre-rounding also compensates for.
 */
export function phpRound(value: number, precision: number): number {
	const factor = 10 ** precision;
	const scaled = Number((Math.abs(value) * factor).toPrecision(15));
	return (Math.sign(value) || 1) * (Math.round(scaled) / factor);
}

/**
 * The host record's matrix row as the widgets read it — or null when there is
 * no readable record (no table, a non-matrix store, no row).
 *
 * The ROW read goes through the read-scoped memo (db/record_memo.ts): widgets
 * ask for one component at a time, so a widget with N declared paths over the
 * same record would otherwise fetch that whole row N times. The memo makes it
 * once per read; with no read scope active it is a direct read.
 */
export async function readWidgetRecord(
	sectionTipo: string,
	sectionId: number | string,
): Promise<MatrixRecord | null> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return null;
	// A VIRTUAL section whose declared matrix_table is not a readable record
	// store (dd15 Time Machine -> matrix_time_machine, flat columns, rejected by
	// the identifier allowlist) has NO record to read: serve the empty value the
	// same way section/read.ts serves its no-record branch, never a 500.
	if (!isMatrixTable(table)) return null;
	return memoizedReadMatrixRecord(table, sectionTipo, Number(sectionId));
}

/**
 * A component's data as PHP component_common::get_data() returns it — the
 * FULL stored item array, NO lang filtering (that is get_data_lang; test_info
 * reads the first item of a translatable source verbatim — verified against
 * live PHP on test3/1's lg-eng-only data). The ONE widget that reads a lang
 * slice is `tags` (oh/tags.ts — the record's text slice, v6 class.tags.php;
 * T1-44, WC-2026-11-13-tags-widget-original-lang).
 */
export async function readWidgetComponentData(
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
): Promise<unknown[]> {
	const record = await readWidgetRecord(sectionTipo, sectionId);
	if (record === null) return [];
	const model = await getModelByTipo(componentTipo);
	if (model === null) return [];
	const { readComponentItems } = await import('../../../resolve/component_data.ts');
	return readComponentItems(record, componentTipo, model) ?? [];
}

/** Resolve the 'current' sentinel on a source descriptor field. */
export function resolveCurrent(declared: unknown, own: string | number): string | number {
	return declared === undefined || declared === null || declared === 'current'
		? own
		: (declared as string | number);
}

export interface TypedInput {
	type?: string;
	section_tipo?: string;
	// KEPT UNION: an ipo source descriptor is ONTOLOGY-authored config, and its
	// id is not always an address — 'current' is the sentinel resolveCurrent()
	// swaps for the host record's own id (WC-2026-08-10-section-id-int-canonical).
	section_id?: string | number;
	component_tipo?: string;
}

/** array_reduce($input, …) keep-last-match — PHP scans the whole array. */
export function findTyped(input: unknown[], type: string): TypedInput | undefined {
	let found: TypedInput | undefined;
	for (const item of input) {
		if ((item as TypedInput)?.type === type) found = item as TypedInput;
	}
	return found;
}
