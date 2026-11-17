/**
 * The write engine's VALUE gates — the ONE home of the transforms a component
 * value passes through before it is stored, each keyed on what the model itself
 * declares.
 *
 * SEC — component_password is an ordinary string component to the write engine,
 * so an unhashed value would be stored VERBATIM: the client's plaintext password
 * straight into matrix_users.string.dd133 (and it would then fail every login,
 * since auth.ts accepts only Argon2id). PHP hashed on the way in
 * (component_password::Save → hash_password); this is that gate.
 *
 * XSS-01 (2026-07-28 audit) / P2-6 (2026-08-26) — a value whose descriptor
 * declares the `html` render class is the ONE class the client passes through
 * unescaped, so it is the ONE class sanitized here (strip script/style/on*=/js:
 * URLs, keep formatting). Keyed on the descriptor facet, never on the model
 * string: a model that declares 'html' opts into this sanitizer in that line.
 * A model WITHOUT a descriptor (component_ip, component_layout, …) is not asked
 * for a class — it has no matrix column either, so the graceful `no matrix
 * column` refusal downstream stays the answer, as it was before.
 *
 * T1-40 / O06, OX2 — a component_number value is formatted as its node declares
 * (`properties.type` / `precision`: int truncates, float rounds; untyped kept;
 * a non-integer precision refused loudly, but only for a value it must format)
 * — PHP `component_number::set_data` →
 * `set_format_form_type`. The law is `components/component_number/number_format.ts`;
 * it is keyed on the matrix COLUMN the model stores in ('number'), and read off
 * the DATA tipo the value is stored under (an alias writes with its target's format).
 *
 * WHO CALLS IT. Not the record chokepoint (`persistRecordKeys` writes keys whose
 * model it does not know — relations, counters, ontology rows, TM replays), but
 * every writer that KNOWS it is storing a component value: the save door
 * (`saveComponentData` → `applySaveComponentData`) and the whole-value writers
 * that bypass it (`translateAndWrite`, T1-14 / OX7 — PHP sanitized there through
 * `component_text_area::save`; the Time Machine restore doors, C58 — PHP
 * restored through `component->Save()`; see {@link gateReplayedValue}). That
 * claim is censused, not prose:
 * `test/unit/component_value_gate_census_tripwire.test.ts` derives every caller
 * of the chokepoint's key / column / replay entries and requires each to reach
 * this gate or carry a named, reasoned exemption.
 */

import {
	formatNumberItems,
	numberFormatOf,
} from '../../components/component_number/number_format.ts';
import { getComponentModel, getRenderClass } from '../../components/registry.ts';
import { DedaloError } from '../../errors/index.ts';
import {
	getColumnNameByModel,
	getModelByTipo,
	getPropertiesByTipo,
} from '../../ontology/resolver.ts';

/**
 * Gate a list of changes (each carrying a `value`: one item or an item array)
 * for `model`, stored under `componentTipo` (the DATA tipo). Returns new
 * changes; the input is never mutated.
 */
export async function applyWriteValueGates<T extends { value: unknown }>(
	model: string,
	componentTipo: string,
	changes: readonly T[],
): Promise<T[]> {
	if (model === 'component_password') {
		return await (await import('../../security/password_hash.ts')).hashPasswordChanges(changes);
	}
	if (getComponentModel(model) !== undefined && getRenderClass(model) === 'html') {
		const { mapRichTextChanges, sanitizeRichText } = await import(
			'../../security/html_sanitize.ts'
		);
		// TODO-067: a media src on an absolute webBase is persisted relative (WC-042).
		const { relativizeMediaSrc } = await import('../../media/web_base_src.ts');
		return mapRichTextChanges(changes, (value) => relativizeMediaSrc(sanitizeRichText(value)));
	}
	if (getColumnNameByModel(model) === 'number') {
		return await formatNumberChanges(componentTipo, changes);
	}
	return [...changes];
}

/**
 * T1-40 — every number item of `changes` formatted as `componentTipo` declares.
 * The format is resolved LAZILY (T1-40 review): a malformed node's refusal is
 * met only by a change that carries a finite number — a clear (`{value:null}`
 * slot, `set_data` null) saves, as PHP's `set_data` skipped the cast for empty
 * data.
 */
async function formatNumberChanges<T extends { value: unknown }>(
	componentTipo: string,
	changes: readonly T[],
): Promise<T[]> {
	const properties = await getPropertiesByTipo(componentTipo);
	const format = () => numberFormatOf(properties, componentTipo);
	return changes.map((change) => {
		if (Array.isArray(change.value)) {
			return { ...change, value: formatNumberItems(change.value, format) };
		}
		const [item] = formatNumberItems([change.value], format);
		return { ...change, value: item };
	});
}

/**
 * Gate a whole component value (its item array) for `model` — for the
 * whole-value writers that store through `persistRecordKeys` instead of the
 * save door. Same transforms, same keying, as a save.
 */
export async function gateComponentItems(
	model: string,
	componentTipo: string,
	items: readonly unknown[],
): Promise<unknown[]> {
	const [gated] = await applyWriteValueGates(model, componentTipo, [{ value: [...items] }]);
	return (gated?.value ?? []) as unknown[];
}

/**
 * Gate a value REPLAYED FROM HISTORY — a Time Machine image a restore door
 * writes back (C58 / T1-14 N1, WC-2026-11-17-tm-restore-value-gates). A history
 * row is stored bytes, but not bytes every gate has seen: a row written before
 * a gate existed (or by a door that bypassed it) holds the raw value, and a
 * replay would store it raw again. So a replay passes the SAME gates as a save:
 * cleaned exactly as a save cleans it (rich text sanitized, a number formatted
 * as its node declares, a stored hash verbatim), refused with the gate's own
 * typed error where a save is refused (a malformed number node). A value every
 * gate already saw comes back byte-identical.
 *
 * ONE RULE IS STRICTER THAN A SAVE'S: a credential ({@link
 * assertReplayableCredential}). A save takes a non-hash password as a NEW
 * plaintext and hashes it; a replay never carries a new password, so a non-hash
 * credential image is refused instead of minted into a hash.
 *
 * `value` is whatever the image holds under the key — an item array, or one
 * item; an absent / null image (the key is removed) has nothing to gate.
 */
export async function gateReplayedValue(
	model: string,
	componentTipo: string,
	value: unknown,
): Promise<unknown> {
	if (value === null || value === undefined) return value;
	await assertReplayableCredential(model, componentTipo, value);
	const [gated] = await applyWriteValueGates(model, componentTipo, [{ value }]);
	return (gated as { value: unknown }).value;
}

/**
 * A `component_password` image must already be a stored hash (or empty) —
 * else `tool.snapshot_unrestorable`, nothing written. Stored bytes that are not
 * a hash are a legacy v6 ciphertext or a plaintext a pre-gate door stored
 * (security/password_hash.ts isReplayablePasswordValue): hashing either would
 * turn history bytes into a working credential, and writing either raw is what
 * this gate exists to stop. The value never rides the error.
 */
async function assertReplayableCredential(
	model: string,
	componentTipo: string,
	value: unknown,
): Promise<void> {
	if (model !== 'component_password') return;
	const { isReplayablePasswordValue } = await import('../../security/password_hash.ts');
	if (isReplayablePasswordValue(value)) return;
	throw new DedaloError('tool.snapshot_unrestorable', {
		coordinates: { tipo: componentTipo, reason: 'the credential image is not a stored hash' },
	});
}

/**
 * Gate a WHOLE-RECORD image (matrix jsonb column → key → value) — the
 * whole-record restore door. Every key that is a component storing in THAT
 * column passes {@link gateReplayedValue}; anything else is returned verbatim:
 * section metadata, counters, the derived `relation_search` index, a tipo the
 * ontology no longer knows, a column that is not a key map. Returns new
 * containers in the image's own key order; the input is never mutated.
 */
export async function gateReplayedColumns<C extends string>(
	columns: Readonly<Partial<Record<C, unknown>>>,
): Promise<Partial<Record<C, unknown>>> {
	const gated: Partial<Record<C, unknown>> = {};
	for (const [column, keys] of Object.entries(columns) as [C, unknown][]) {
		gated[column] = await gateReplayedColumn(column, keys);
	}
	return gated;
}

/** One column of a whole-record image (see {@link gateReplayedColumns}). */
async function gateReplayedColumn(column: string, keys: unknown): Promise<unknown> {
	if (!isKeyMap(keys)) return keys;
	const gated: Record<string, unknown> = {};
	for (const [tipo, value] of Object.entries(keys)) {
		const model = await componentStoredIn(column, tipo);
		gated[tipo] = model === null ? value : await gateReplayedValue(model, tipo, value);
	}
	return gated;
}

/** A column image that is a key → value map (never null, a scalar or an array). */
function isKeyMap(keys: unknown): keys is Record<string, unknown> {
	return keys !== null && typeof keys === 'object' && !Array.isArray(keys);
}

/** The model of `tipo` when it is a component whose values live in `column`; else null. */
async function componentStoredIn(column: string, tipo: string): Promise<string | null> {
	const model = await getModelByTipo(tipo);
	return model !== null && getColumnNameByModel(model) === column ? model : null;
}
