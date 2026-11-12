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
 * WHO CALLS IT. Not the record chokepoint (`persistRecordKeys` writes keys whose
 * model it does not know — relations, counters, ontology rows, TM replays), but
 * every writer that KNOWS it is storing a component value: the save door
 * (`saveComponentData` → `applySaveComponentData`) and the whole-value writers
 * that bypass it (`translateAndWrite`, T1-14 / OX7 — PHP sanitized there through
 * `component_text_area::save`). That claim is censused, not prose:
 * `test/unit/component_value_gate_census_tripwire.test.ts` derives every caller
 * of the chokepoint and requires each to reach this gate or carry a named,
 * reasoned exemption.
 */

import { getComponentModel, getRenderClass } from '../../components/registry.ts';

/**
 * Gate a list of changes (each carrying a `value`: one item or an item array)
 * for `model`. Returns new changes; the input is never mutated.
 */
export async function applyWriteValueGates<T extends { value: unknown }>(
	model: string,
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
	return [...changes];
}

/**
 * Gate a whole component value (its item array) for `model` — for the
 * whole-value writers that store through `persistRecordKeys` instead of the
 * save door. Same transforms, same keying, as a save.
 */
export async function gateComponentItems(
	model: string,
	items: readonly unknown[],
): Promise<unknown[]> {
	const [gated] = await applyWriteValueGates(model, [{ value: [...items] }]);
	return (gated?.value ?? []) as unknown[];
}
