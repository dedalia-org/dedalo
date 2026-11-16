/**
 * Import data engine (PHP component_common::conform_import_data +
 * unwrap_dedalo_data). Turns a CSV cell into a v7 component value.
 *
 * TWO PATHS, and the difference is the whole design:
 *
 *   - a cell that IS json is the STORED DATA coming back (a `dedalo_raw` export
 *     wraps each component's stored slice as {"dedalo_data": <slice>}).
 *     Re-importing it must reproduce it EXACTLY — the round-trip invariant.
 *     This path is mostly
 *     model-agnostic, so it works for every component model, ported or not.
 *   - a cell that is NOT json is HUMAN input ('12-03-1998', '1.234,56',
 *     '41.38, 2.17', '273,418'). Parsing it is model-specific: each model
 *     declares an `importConform` facet (tools/import_conform.ts) and that facet
 *     owns the cell.
 *
 * Without a facet a flat cell is REFUSED (a loud error on the row), never
 * written. This matters: a refused cell leaves the record's existing value
 * intact, whereas "conform to null and save" would CLEAR it — a silent
 * destruction of data the CSV never meant to touch. PHP is laxer here (it stores
 * the raw string and corrupts the column); we do not copy that.
 *
 * THE ONE EXCEPTION to "json always round-trips" (2026-08-05): a DERIVED field
 * refuses BOTH cell shapes. See the relation-column check in conformImportData.
 */

import {
	allComponentModels,
	getComponentModel,
	getImportConformId,
} from '../components/registry.ts';
import { IMPORT_CONFORM, type ImportConformContext, type JsonCell } from './import_conform.ts';

/**
 * PHP component_common::$components_using_value_property (bare scalar →
 * {value}). DERIVED from the descriptor facet `importValueProperty` (S2-26)
 * — a new model opts in by declaring the facet, never by editing this file.
 * CANONICAL names only (PHP's list is canonical; legacy aliases resolve to
 * their canonical model before import conforming). Membership is pinned by
 * test/unit/descriptor_completeness_tripwire.test.ts.
 */
export const VALUE_PROPERTY_MODELS: ReadonlySet<string> = new Set(
	allComponentModels()
		.filter((descriptor) => descriptor.importValueProperty === true)
		.map((descriptor) => descriptor.model),
);

/**
 * PHP json_handler::is_json (:190): TRUE only when the string DECODES to an array
 * or an object. Not a first-character sniff — '[Ac]' starts with '[' and is not
 * json, and PHP therefore treats it as literal text. (Our previous first-char
 * check called it a JSON decode failure and rejected the cell.) Bare scalars
 * ('5', 'true', 'null') are likewise NOT json here, which is why the string
 * branch ever sees a number at all.
 */
export function isJson(value: string): boolean {
	const trimmed = value.trimStart();
	if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return false;
	try {
		const decoded = JSON.parse(value);
		return decoded !== null && typeof decoded === 'object';
	} catch {
		return false;
	}
}

/** Decode a cell once: {isJson, decoded} — the shape every facet receives. */
export function decodeCell(value: string): JsonCell {
	if (!isJson(value)) return { isJson: false, decoded: null };
	return { isJson: true, decoded: JSON.parse(value) as unknown };
}

export interface UnwrapResult {
	/** The unwrapped inner dato re-encoded as a JSON string (or '' when empty). */
	value: string;
	/** Whether the {"dedalo_data":…} wrapper was recognized (its SOLE property). */
	wrapped: boolean;
	/** The dataframe array when the inner used the LEGACY {data, dataframe} envelope. */
	dataframe: unknown[] | null;
	/**
	 * False when the legacy envelope carried ONLY frames ({"dataframe":[…]} with
	 * no data key): the component's own data must then be left UNTOUCHED — only
	 * the frames are written. Distinct from an empty value, which CLEARS.
	 */
	hasData: boolean;
}

/**
 * The READ-ONLY LEGACY inner envelope
 * (WC-2026-08-09-export-raw-dataframe-own-column): frames folded into their
 * main component's cell as {data|dato, dataframe}. Since 2026-08-09 the raw
 * export gives every dataframe slot its OWN column, so nothing we write ever
 * carries this again — but files exported before that, and v6/PHP-era files
 * (which spelled the key `dato`), must still import. Both spellings are
 * accepted; neither is ever emitted.
 *
 * Returns null when `inner` is not that envelope, so the caller passes it
 * through as an ordinary wrapped value.
 */
function splitLegacyFrameEnvelope(
	inner: unknown,
): { value: unknown; dataframe: unknown[] | null; hasData: boolean } | null {
	if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return null;
	const keys = Object.keys(inner);
	if (!keys.includes('dataframe')) return null;
	if (!keys.every((key) => key === 'data' || key === 'dato' || key === 'dataframe')) return null;

	const envelope = inner as { data?: unknown; dato?: unknown; dataframe?: unknown };
	const hasData = Object.hasOwn(envelope, 'data');
	return {
		value: (hasData ? envelope.data : envelope.dato) ?? null,
		dataframe: Array.isArray(envelope.dataframe) ? envelope.dataframe : null,
		hasData: hasData || Object.hasOwn(envelope, 'dato'),
	};
}

/**
 * Strip the dedalo_data wrapper (PHP unwrap_dedalo_data). Recognized only when
 * `dedalo_data` is the SOLE property — {"dedalo_data":1,"other":2} is a legit
 * component_json value and passes through unchanged. The legacy frame envelope
 * inside it, if any, is split out by splitLegacyFrameEnvelope.
 */
export function unwrapDedaloData(importValue: string): UnwrapResult {
	const result: UnwrapResult = {
		value: importValue,
		wrapped: false,
		dataframe: null,
		hasData: true,
	};
	if (!isJson(importValue)) return result;
	let decoded: unknown;
	try {
		decoded = JSON.parse(importValue);
	} catch {
		return result;
	}
	if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return result;
	const keys = Object.keys(decoded);
	if (keys.length !== 1 || keys[0] !== 'dedalo_data') return result;

	let inner = (decoded as { dedalo_data: unknown }).dedalo_data;
	const legacy = splitLegacyFrameEnvelope(inner);
	if (legacy !== null) {
		inner = legacy.value;
		result.dataframe = legacy.dataframe;
		result.hasData = legacy.hasData;
	}
	if (inner === null) {
		result.value = '';
		result.wrapped = false;
	} else {
		// PHP JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES — JS JSON.stringify
		// already leaves unicode + slashes unescaped, matching byte-for-byte.
		result.value = JSON.stringify(inner);
		result.wrapped = true;
	}
	return result;
}

/**
 * The items to save, keyed by the lang they belong to.
 *
 * Three shapes arrive from conform, and only the first is obvious:
 *   - a lang-keyed OBJECT ({"lg-eng":[…], "lg-spa":[…]}) — a translatable export;
 *   - a FLAT array whose items each carry their own `lang` — the v7 stored shape
 *     (the raw export emits exactly this). Grouping it by item lang is what keeps
 *     every translation: a single set_data would force them all to the import lang;
 *   - a flat array with no langs — one group, at the component's own lang.
 *
 * Every executor that saves a conform result MUST group through here and save
 * one lang at a time (the save engine's set_data is lang-sliced, PHP
 * set_data_lang) — a flat merged save loses translations.
 */
export function groupItemsByLang(result: unknown, componentLang: string): Map<string, unknown[]> {
	const isObject = (value: unknown): value is Record<string, unknown> =>
		value !== null && typeof value === 'object' && !Array.isArray(value);
	const groups = new Map<string, unknown[]>();
	if (result === null || result === undefined) return groups;

	if (isObject(result)) {
		for (const [lang, value] of Object.entries(result)) {
			if (!lang.startsWith('lg-')) continue;
			groups.set(lang, Array.isArray(value) ? value : [value]);
		}
		if (groups.size > 0) return groups;
	}

	const items = Array.isArray(result) ? result : [result];
	const hasItemLangs = items.some(
		(item) => isObject(item) && typeof item.lang === 'string' && item.lang !== '',
	);
	if (!hasItemLangs) {
		groups.set(componentLang, items);
		return groups;
	}
	for (const item of items) {
		const lang =
			isObject(item) && typeof item.lang === 'string' && item.lang !== ''
				? item.lang
				: componentLang;
		const group = groups.get(lang);
		if (group === undefined) groups.set(lang, [item]);
		else group.push(item);
	}
	return groups;
}

/** A failed/warning report object (the report's ImportRowIssue is built from it). */
export interface ConformFailure {
	section_id: number;
	data: unknown;
	component_tipo: string;
	msg: string;
}

export interface ConformResult {
	/** The conformed dato: array of v7 items | lang-keyed object | null (clear). */
	result: unknown;
	errors: ConformFailure[];
	/** Accepted, but flagged for a human (today: only component_select_lang). */
	warnings: ConformFailure[];
	msg: string;
	/**
	 * Frames the EXECUTOR must derive for items of `result` (T0-12: a
	 * component_iri label → its dd560 frame). Conform runs at plan/preview time,
	 * outside any transaction, so it never writes: it states the INTENT and the
	 * executor resolves + writes it inside the row's transaction
	 * (`import_iri_label.ts`). Absent = none. Never on the stored item.
	 */
	derivedFrames?: IriLabelIntent[];
}

/**
 * One label an imported component_iri item carries (T0-12). `item` is the
 * item's position in `result`: in the lang's array when `lang` names a key of a
 * lang-keyed result, else in the flat array (`lang` null).
 */
export interface IriLabelIntent {
	/** The fixed label slot of component_iri (dd560). */
	slot: 'dd560';
	lang: string | null;
	item: number;
	/** An existing dd1706 record id, or a label TEXT to find-or-create. */
	target: { section_id: number } | { label: string };
}

export interface ConformInput {
	model: string;
	importValue: string;
	columnName: string;
	/** The section being imported INTO (a relation resolves its targets against it). */
	sectionTipo: string;
	sectionId: number;
	componentTipo: string;
	/** The component's save lang ('lg-nolan' when not translatable). */
	lang?: string;
	/** True when the cell came out of a {"dedalo_data":…} wrapper. */
	wrapped?: boolean;
	/** The column map's decimal separator (component_number). */
	decimal?: string;
	/**
	 * The value is TEXT, not a cell: it is never JSON-decoded (MARC21 values —
	 * a '[1987]' stays the text '[1987]'). The facet's flat branch owns it.
	 */
	literal?: boolean;
}

/** The decoded cell — a LITERAL value is text and is never JSON-decoded. */
function cellOf(input: ConformInput): JsonCell {
	return input.literal === true ? { isJson: false, decoded: null } : decodeCell(input.importValue);
}

/**
 * Conform one CSV cell to a component dato.
 *
 * Order: the model's `importConform` facet owns the cell when it has one (it
 * handles BOTH its json and its flat forms — the model particularities live
 * there, not here). Otherwise: a json cell round-trips through the generic
 * normalizer, an empty cell clears, and a flat cell is REFUSED.
 */
export async function conformImportData(input: ConformInput): Promise<ConformResult> {
	const json = cellOf(input);
	const conformId = getImportConformId(input.model);

	if (conformId !== undefined) {
		const ctx: ImportConformContext = {
			model: input.model,
			componentTipo: input.componentTipo,
			sectionTipo: input.sectionTipo,
			sectionId: input.sectionId,
			columnName: input.columnName,
			lang: input.lang ?? 'lg-nolan',
			wrapped: input.wrapped ?? false,
			decimal: input.decimal,
			literal: input.literal,
		};
		return IMPORT_CONFORM[conformId](input.importValue, json, ctx);
	}

	// --- no facet: the generic path -----------------------------------------
	const isValueProperty = VALUE_PROPERTY_MODELS.has(input.model);
	const failure = (msg: string): ConformFailure => ({
		section_id: input.sectionId,
		data: input.importValue,
		component_tipo: input.componentTipo,
		msg,
	});

	// A RELATION-column model with no facet is a DERIVED field (2026-08-05:
	// component_external, whose value lives in a third-party API — every other
	// relation model is required to declare a parser, and
	// descriptor_completeness_tripwire enforces that). It has no importable
	// form at all, so even the model-agnostic json round-trip is refused: the
	// local record has no slot the imported bytes belong in, and writing them
	// would put a fossil into a column the read path never consults again.
	if (getComponentModel(input.model)?.column === 'relation') {
		return {
			result: null,
			errors: [
				failure(
					`IGNORED: '${input.model}' is a DERIVED field — its value comes from an external service, so it can never be written from an import`,
				),
			],
			warnings: [],
			msg: 'Error. Request failed',
		};
	}

	if (json.isJson) {
		const normalizeItems = (items: unknown[]): unknown[] =>
			items.map((v) =>
				(typeof v !== 'object' || v === null) && isValueProperty ? { value: v } : v,
			);
		let value: unknown = json.decoded;
		if (Array.isArray(value)) {
			value = normalizeItems(value);
		} else if (value !== null && typeof value === 'object') {
			const keys = Object.keys(value);
			const firstKey = keys[0];
			if (firstKey?.startsWith('lg-')) {
				const obj = value as Record<string, unknown>;
				for (const lang of keys) {
					const langValue = obj[lang];
					obj[lang] = normalizeItems(Array.isArray(langValue) ? langValue : [langValue]);
				}
			} else {
				const item = isValueProperty && !('value' in value) ? { value } : value;
				value = [item];
			}
		}
		return { result: value, errors: [], warnings: [], msg: 'OK' };
	}

	// '0' is a value, not an absence (PHP's one empty() exception).
	if (input.importValue === '') {
		return { result: null, errors: [], warnings: [], msg: 'OK' };
	}

	if (isValueProperty) {
		return {
			result: [{ value: input.importValue }],
			errors: [],
			warnings: [],
			msg: 'OK',
		};
	}

	// A flat cell for a model with no flat form. Writing it would either store a
	// raw string in a structured column (PHP's behavior — corruption) or flatten
	// to [] and CLEAR the record's existing value. Refuse, loudly and per-cell.
	return {
		result: null,
		errors: [
			failure(
				`IGNORED: '${input.model}' has no flat-value import form — the cell was NOT written, and the existing value was left untouched`,
			),
		],
		warnings: [],
		msg: 'Error. Request failed',
	};
}
