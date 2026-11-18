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
 * `component_text_area::save`; the Time Machine restore doors and the bulk
 * revert's writers, C58 — PHP restored through `component->Save()`; see
 * {@link gateReplayedValue}). Every save is done the same way (owner ruling
 * 2026-11-18): no door replays a stored image past the gates. That claim is
 * censused, not prose:
 * `test/unit/component_value_gate_census_tripwire.test.ts` derives every caller
 * of EVERY chokepoint entry and requires each to reach this gate in its own
 * file, or carry the named `non_literal` exemption with its mechanism.
 */

import {
	formatNumberItems,
	numberFormatOf,
} from '../../components/component_number/number_format.ts';
import { getComponentModel, getRenderClass } from '../../components/registry.ts';
import { DedaloError, isDedaloError } from '../../errors/index.ts';
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
 * writes back, an undo-log or snapshot image the bulk revert writes back
 * (C58 / T1-14 N1, WC-2026-11-17-tm-restore-value-gates). A history
 * row is stored bytes, but not bytes every gate has seen: a row written before
 * a gate existed (or by a door that bypassed it) holds the raw value, and a
 * replay would store it raw again. So a replay passes the SAME gates as a save:
 * cleaned exactly as a save cleans it (rich text sanitized, a number formatted
 * as its node declares, a stored hash verbatim), refused with the gate's own
 * typed error where a save is refused (a malformed number node). A value every
 * gate already saw comes back byte-identical.
 *
 * ONE RULE DIFFERS FROM A SAVE'S: a credential ({@link
 * assertReplayableCredential}). A save takes a non-hash password as a NEW
 * plaintext and hashes it; a replay never carries a new password, so a
 * credential image is never hashed: it is put back VERBATIM when it is stored
 * bytes a replay may carry (a hash, a legacy v6 ciphertext), refused otherwise.
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
	if (model === 'component_password') {
		await assertReplayableCredential(componentTipo, value);
		return value;
	}
	const [gated] = await applyWriteValueGates(model, componentTipo, [{ value }]);
	return (gated as { value: unknown }).value;
}

/**
 * What a replay of `value` WOULD store — for a door that must JUDGE a stored
 * value against it before deciding to write (the bulk revert: is the key
 * already at what the revert leaves?). A value the gates REFUSE is judged as
 * recorded: the refusal belongs to the WRITE ({@link gateReplayedValue}), which
 * a judgement that finds nothing to write never reaches.
 */
export async function judgeReplayedValue(
	model: string,
	componentTipo: string,
	value: unknown,
): Promise<unknown> {
	try {
		return await gateReplayedValue(model, componentTipo, value);
	} catch (error) {
		if (isDedaloError(error)) return value;
		throw error;
	}
}

/**
 * A `component_password` image must be stored bytes a replay may carry — empty,
 * an Argon2 hash, or a LEGACY v6 CIPHERTEXT (owner ruling 2026-11-18: replayed
 * verbatim, so a user record from before the upgrade restores and
 * `scripts/migrate_v6_passwords.ts` still converts it; `auth.ts` accepts only
 * Argon2id, so it is no working credential) — else
 * `tool.snapshot_credential_unrestorable`, nothing written. What is refused is
 * a plaintext a pre-gate door stored (security/password_hash.ts
 * isReplayablePasswordValue — the v6 format is the discriminator, its residual
 * stated there): hashing it would turn history bytes into a working
 * credential, and writing it raw is what this gate exists to stop. The value
 * never rides the error; the code is the credential's own, so the user is told
 * to set a new password, not that a link is malformed.
 */
async function assertReplayableCredential(componentTipo: string, value: unknown): Promise<void> {
	const { isReplayablePasswordValue } = await import('../../security/password_hash.ts');
	if (isReplayablePasswordValue(value)) return;
	throw new DedaloError('tool.snapshot_credential_unrestorable', {
		coordinates: {
			tipo: componentTipo,
			reason: 'the credential image is neither a stored hash nor a legacy v6 ciphertext',
		},
	});
}

/** What {@link gateOrCollect} answers for a key whose refusal went to the sink. */
export const REFUSED_KEY: unique symbol = Symbol('a key the gates refused');

/**
 * Run the gate of ONE key of a whole-record image. Without a sink its refusal
 * is THROWN — every door but one. With a sink, a TYPED refusal is pushed onto
 * it and the key answered {@link REFUSED_KEY}: the caller leaves that key OUT
 * of the image it writes.
 *
 * The sink exists for the one door that must ask something of the WRITTEN row
 * before a refusal may surface — the undelete of a missing record, whose
 * record scope is judged on the restored row (tool_time_machine.ts
 * restoreAbsentSectionRow): throwing at the gate answered "this image is
 * refused" to a principal the scope check had not judged yet. (!) A door that
 * passes a sink owes the throw: an image missing a refused key is written only
 * inside a transaction that the first collected refusal — or the verdict it
 * waited for — rolls back. Anything untyped propagates either way.
 */
export async function gateOrCollect<T>(
	gate: () => T | Promise<T>,
	refusals: DedaloError[] | undefined,
): Promise<T | typeof REFUSED_KEY> {
	if (refusals === undefined) return gate();
	try {
		return await gate();
	} catch (error) {
		if (!isDedaloError(error)) throw error;
		refusals.push(error);
		return REFUSED_KEY;
	}
}

/**
 * Gate a WHOLE-RECORD image (matrix jsonb column → key → value) — the
 * whole-record restore door. Every key that is a component storing in THAT
 * column passes {@link gateReplayedValue}; anything else is returned verbatim:
 * section metadata, counters, the derived `relation_search` index, a tipo the
 * ontology no longer knows, a column that is not a key map. Returns new
 * containers in the image's own key order; the input is never mutated.
 *
 * `refusals` (see {@link gateOrCollect}): absent, the first key the gates
 * refuse throws; given, every refused key is left out and its error collected.
 */
export async function gateReplayedColumns<C extends string>(
	columns: Readonly<Partial<Record<C, unknown>>>,
	refusals?: DedaloError[],
): Promise<Partial<Record<C, unknown>>> {
	const gated: Partial<Record<C, unknown>> = {};
	for (const [column, keys] of Object.entries(columns) as [C, unknown][]) {
		gated[column] = await gateReplayedColumn(column, keys, refusals);
	}
	return gated;
}

/** One column of a whole-record image (see {@link gateReplayedColumns}). */
async function gateReplayedColumn(
	column: string,
	keys: unknown,
	refusals: DedaloError[] | undefined,
): Promise<unknown> {
	if (!isKeyMap(keys)) return keys;
	const gated: Record<string, unknown> = {};
	for (const [tipo, value] of Object.entries(keys)) {
		const model = await componentStoredIn(column, tipo);
		const stored =
			model === null
				? value
				: await gateOrCollect(() => gateReplayedValue(model, tipo, value), refusals);
		if (stored !== REFUSED_KEY) gated[tipo] = stored;
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
