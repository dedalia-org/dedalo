/**
 * THE MACHINE-NAME SAVE RULES AT THE RECORD-WRITE CHOKEPOINT (plan §4,
 * WC-2026-11-04-ontology-machine-names). The pure rules and the restore kernel
 * live in ontology/machine_name_rules.ts; this module reads what they need —
 * the record before the write, UNDER ITS ROW LOCK, inside the write's own
 * transaction — and acts on the verdict:
 *
 *  - every SAVE door (record_write.ts persistRecordKeys and its siblings,
 *    persistAppendedKeyItems: the edit form, ts_object / dd_ts_api term saves,
 *    CSV/JSON import, MCP fields_write / records_write — all of them reach
 *    saveComponentData → these entries) → `assertMachineNameWrite`: a write that
 *    INTRODUCES a violation throws a typed `ontology.machine_name_*` DedaloError
 *    (400, caller) and its transaction rolls back;
 *  - every RESTORE door (persistRestoredKeys: the TM component restore and the
 *    bulk revert-undo; persistRecordColumns / the birth: the TM whole-record
 *    restore and the undelete) → `convertRestoredKeys` / `convertRestoredColumns`:
 *    never refused, the restored state passes through the conversion kernel.
 *
 * SCOPE, decided without a database read (machine_name_rules.ts `machineNameScope`): a canonical node
 * section `<tld>0` (tld.ts requiredOntologyTld) whose write touches one of the
 * keys the rules read (TRIGGER_KEYS), or a localontology0 override touching
 * ontology42/43/44. Every other write pays one Set lookup. And the rules are
 * ARMED only on an ontology that defines ontology43 AND ontology44
 * (getModelByTipo): an ontology release older than them (the vendored 7.0 today)
 * has no component an operator could satisfy the guidance with, so nothing is
 * refused there and the parser's legacy rungs carry the names.
 *
 * KNOWN SIMPLIFICATIONS (stated, not hidden):
 *  - a canonical record is classified by ITS OWN model (ontology6), not the
 *    override-merged one the parser uses for an override (plan §5): an override
 *    that changes a node's model is reported by inspect, not refused here;
 *  - an undelete (birth) has no "current" record: its snapshot is compared with
 *    itself, so a legacy snapshot reborn into a converted tld stays legacy and
 *    shows up in inspect (`flag_mismatch` / rung counters) for the converter;
 *  - a conversion that writes ontology43/44 next to a restored ontology5 writes
 *    those siblings without a Time Machine row of their own (the restore door
 *    records the key it restored) — reported as a counter + log line.
 */

import { incrementCounter } from '../api/counters.ts';
import { AUDIT_TIPOS } from '../concepts/section.ts';
import { readDdOntologyRow } from '../db/dd_ontology.ts';
import { type MatrixJsonbColumn, readMatrixRecord } from '../db/matrix.ts';
import type { MatrixWriteValues } from '../db/matrix_write.ts';
import { readMatrixKeyForUpdate } from '../db/matrix_write.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { deriveLegacyMachineName, isNameClassNode, modelNameOf } from '../ontology/machine_name.ts';
import {
	type CanonicalNameState,
	canonicalTransitionViolation,
	convertRestoredMachineName,
	flagFromItems,
	introducedViolation,
	literalStrings,
	type MachineNameScope,
	type MachineNameViolation,
	machineNameFlagItems,
	machineNameItems,
	machineNameScope,
	type OverrideNameState,
	overrideNameViolations,
	type RestoreConversion,
	type StoredLiteralItem,
	termItemsFromStored,
} from '../ontology/machine_name_rules.ts';
import {
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_MODEL,
	ONTOLOGY_OVERWRITE,
	ONTOLOGY_TERM,
	ONTOLOGY_USE_MACHINE_NAME,
} from '../ontology/ontology_tipos.ts';
import { getTermIdFromLocator } from '../ontology/parser.ts';
import { getColumnNameByModel, getModelByTipo } from '../ontology/resolver.ts';
import { buildTipo, requiredOntologyTld } from '../ontology/tld.ts';

/** The record a rule reads (record_write.ts RecordWriteTarget, structurally). */
export interface MachineNameTarget {
	table: string;
	sectionTipo: string;
	sectionId: number;
}

/** One key write (record_write.ts SavePathItem, structurally). */
export interface MachineNameKeyWrite {
	column: MatrixJsonbColumn;
	key: string;
	value: unknown;
}

/**
 * True when this ontology defines both components — the rules' ARMING
 * condition (module header). Exported so the chokepoint opens its transaction
 * only for a write the rules will actually read.
 */
export async function machineNameComponentsDefined(): Promise<boolean> {
	return (
		(await getModelByTipo(ONTOLOGY_MACHINE_NAME)) !== null &&
		(await getModelByTipo(ONTOLOGY_USE_MACHINE_NAME)) !== null
	);
}

type Columns = Partial<Record<MatrixJsonbColumn, unknown>>;

/** The column a component's data lives in (its model's), or null when the tipo is unknown. */
async function columnOf(componentTipo: string): Promise<MatrixJsonbColumn | null> {
	const model = await getModelByTipo(componentTipo);
	return model === null ? null : (getColumnNameByModel(model) as MatrixJsonbColumn | null);
}

/** A column value as a keyed bag, or null when it is none (NULL, an array, a scalar). */
function bagOf(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** A stored key value as items (PHP coerces a scalar to [$data]; absent → []). */
function asItems(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

/** One component's raw items in a columns bag (null/'' holes dropped, like component_data). */
async function itemsOf(columns: Columns, componentTipo: string): Promise<unknown[] | null> {
	const column = await columnOf(componentTipo);
	if (column === null) return null;
	const items = asItems(bagOf(columns[column])?.[componentTipo]).filter(
		(item) => item !== null && item !== '',
	);
	return items.length > 0 ? items : null;
}

/** `columns` with the key writes applied (value null removes the key) — a fresh object. */
function withKeyWrites(columns: Columns, writes: readonly MachineNameKeyWrite[]): Columns {
	const out: Columns = { ...columns };
	for (const write of writes) {
		const bag = { ...(bagOf(out[write.column]) ?? {}) };
		if (write.value === null) delete bag[write.key];
		else bag[write.key] = write.value;
		out[write.column] = bag;
	}
	return out;
}

/** The record's columns under the row lock (empty when the row is absent). */
async function lockedColumns(target: MachineNameTarget): Promise<Columns> {
	// The lock is the row's: any key works (record_write.ts lockRecordRow).
	await readMatrixKeyForUpdate(
		target.table,
		target.sectionTipo,
		target.sectionId,
		'date',
		AUDIT_TIPOS.modifiedDate,
	);
	const record = await readMatrixRecord(target.table, target.sectionTipo, target.sectionId);
	return (record?.columns ?? {}) as Columns;
}

/** A canonical record's state for the rules: its name, flag, label and classification. */
async function canonicalState(
	target: MachineNameTarget,
	columns: Columns,
): Promise<CanonicalNameState> {
	const tld = requiredOntologyTld(target.sectionTipo) as string;
	const modelLocator = (await itemsOf(columns, ONTOLOGY_MODEL))?.[0] as
		| { section_tipo?: unknown; section_id?: unknown }
		| undefined;
	const modelTipo =
		modelLocator === undefined
			? null
			: await getTermIdFromLocator(modelLocator as Parameters<typeof getTermIdFromLocator>[0]);
	const model = modelTipo === null ? null : modelNameOf(await readDdOntologyRow(modelTipo)).model;
	return {
		nameValues: literalStrings(await itemsOf(columns, ONTOLOGY_MACHINE_NAME)),
		flag: flagFromItems(await itemsOf(columns, ONTOLOGY_USE_MACHINE_NAME)),
		termItems: termItemsFromStored(await itemsOf(columns, ONTOLOGY_TERM)),
		nameClass: isNameClassNode({
			tipo: buildTipo(tld, target.sectionId),
			tld,
			is_model: flagFromItems(await itemsOf(columns, ONTOLOGY_IS_MODEL)) === true,
			model_tipo: modelTipo,
			model,
		}),
	};
}

/** The tipo of the node an override record overrides (its ontology42), or null. */
async function overriddenNodeTipo(columns: Columns): Promise<string | null> {
	const locator = (await itemsOf(columns, ONTOLOGY_OVERWRITE))?.[0];
	if (locator === undefined) return null;
	return getTermIdFromLocator(locator as Parameters<typeof getTermIdFromLocator>[0]);
}

/** The overridden node's effective flag: its derived row's, else the legacy derivation. */
async function nodeFlagOf(nodeTipo: string | null): Promise<boolean | null> {
	if (nodeTipo === null) return null;
	const row = await readDdOntologyRow(nodeTipo);
	if (row === null) return null;
	if (row.use_machine_name !== null && row.use_machine_name !== undefined) {
		return row.use_machine_name;
	}
	return deriveLegacyMachineName(row).use_machine_name;
}

/** An override record's state for the rules. */
async function overrideState(columns: Columns): Promise<OverrideNameState> {
	return {
		nameValues: literalStrings(await itemsOf(columns, ONTOLOGY_MACHINE_NAME)),
		overrideFlag: flagFromItems(await itemsOf(columns, ONTOLOGY_USE_MACHINE_NAME)),
		nodeFlag: await nodeFlagOf(await overriddenNodeTipo(columns)),
	};
}

/** True when the write puts at least one non-empty ontology43 value. */
function writesName(writes: readonly MachineNameKeyWrite[]): boolean {
	return writes.some(
		(write) =>
			write.key === ONTOLOGY_MACHINE_NAME &&
			literalStrings(Array.isArray(write.value) ? write.value : null).some((value) => value !== ''),
	);
}

/**
 * THE SAVE DOORS' CHECK — call INSIDE the write's transaction, before the
 * UPDATE: locks the row, reads it, and throws the first violation the write
 * would introduce (machine_name_rules.ts introducedViolation). A write out of
 * scope, or on an ontology without ontology43/44, returns without a read.
 */
export async function assertMachineNameWrite(
	target: MachineNameTarget,
	writes: readonly MachineNameKeyWrite[],
): Promise<void> {
	const scope = machineNameScope(
		target.sectionTipo,
		writes.map((write) => write.key),
	);
	if (scope === null || !(await machineNameComponentsDefined())) return;
	const before = await lockedColumns(target);
	const after = withKeyWrites(before, writes);
	await assertMachineNameTransition(target, scope, before, after, writesName(writes));
}

/**
 * THE ATOMIC APPEND's check (persistAppendedKeyItems, inside its transaction,
 * before the append): the `after` is the stored value of the key plus the
 * inserted items — what the concatenation will store.
 */
export async function assertMachineNameAppend(
	target: MachineNameTarget,
	column: MatrixJsonbColumn,
	key: string,
	inserts: readonly unknown[],
): Promise<void> {
	const scope = machineNameScope(target.sectionTipo, [key]);
	if (scope === null || !(await machineNameComponentsDefined())) return;
	const before = await lockedColumns(target);
	const value = [...asItems(bagOf(before[column])?.[key]), ...inserts];
	const after = withKeyWrites(before, [{ column, key, value }]);
	await assertMachineNameTransition(
		target,
		scope,
		before,
		after,
		writesName([{ column, key, value: [...inserts] }]),
	);
}

/** The verdict over an explicit before/after pair (the key doors and the append share it). */
export async function assertMachineNameTransition(
	target: MachineNameTarget,
	scope: Exclude<MachineNameScope, null>,
	before: Columns,
	after: Columns,
	nameWritten: boolean,
): Promise<void> {
	if (scope === 'canonical') {
		const state = await canonicalState(target, after);
		const violation = canonicalTransitionViolation(
			await canonicalState(target, before),
			state,
			nameWritten,
		);
		if (violation !== null) {
			const tld = requiredOntologyTld(target.sectionTipo) as string;
			throw machineNameRefusal(violation, target, buildTipo(tld, target.sectionId), {
				flag: state.flag,
				nameClass: state.nameClass,
			});
		}
		return;
	}
	const beforeState = await overrideState(before);
	const afterState = await overrideState(after);
	const violation = introducedViolation(
		overrideNameViolations(beforeState),
		overrideNameViolations(afterState),
		nameWritten,
	);
	if (violation !== null) {
		const node = (await overriddenNodeTipo(after)) ?? `${target.sectionTipo}/${target.sectionId}`;
		throw machineNameRefusal(violation, target, node, {
			flag: afterState.nodeFlag,
			nameClass: null,
		});
	}
}

/** The ontology44 guidance a refusal names (an operator fixes the data with it). */
const FLAG = ONTOLOGY_USE_MACHINE_NAME;
const NAME = ONTOLOGY_MACHINE_NAME;

/** Per violation kind: its registered code and the operator sentence naming the fix. */
const REFUSALS: Record<
	MachineNameViolation['kind'],
	{
		code: ConstructorParameters<typeof DedaloError>[0];
		message: (node: string, rule: string) => string;
	}
> = {
	invalid: {
		code: 'ontology.machine_name_invalid',
		message: (node, rule) =>
			`machine name of ${node} refused: ${rule} (${NAME} is one value, no surrounding whitespace, no control character)`,
	},
	without_flag: {
		code: 'ontology.machine_name_without_flag',
		message: (node) =>
			`machine name of ${node} refused: ${FLAG} is No — set ${FLAG} to Yes first, or leave ${NAME} empty`,
	},
	required: {
		code: 'ontology.machine_name_required',
		message: (node) =>
			`write on ${node} refused: ${FLAG} is Yes and the node would have no machine name — fill ${NAME} (one value) first`,
	},
	flag_mismatch: {
		code: 'ontology.machine_name_flag_mismatch',
		message: (node) =>
			`write on ${node} refused: its model is named by a machine name but ${FLAG} is No — set ${FLAG} to Yes (and ${NAME}) first (D12)`,
	},
	override_flag: {
		code: 'ontology.machine_name_override_flag',
		message: (node) =>
			`override of ${node} refused: ${FLAG} is canonical-only — an override may not change it (leave ${FLAG} empty on the override)`,
	},
};

/** The typed refusal for one violation (registry: ontology.machine_name_*, 400 caller). */
function machineNameRefusal(
	violation: MachineNameViolation,
	target: MachineNameTarget,
	node: string,
	context: { flag: boolean | null; nameClass: boolean | null },
): DedaloError {
	const refusal = REFUSALS[violation.kind];
	const rule = violation.rule ?? violation.kind;
	return new DedaloError(refusal.code, {
		message: refusal.message(node, rule),
		details: violation.kind === 'invalid' ? { node, rule } : { node },
		coordinates: {
			table: target.table,
			section_tipo: target.sectionTipo,
			section_id: target.sectionId,
			tipo: node,
			reason: violation.kind,
			flag: String(context.flag),
			name_class: String(context.nameClass),
		},
	});
}

// --- The restore doors --------------------------------------------------------

/** Count + log one restore conversion that changed something (never silent). */
function reportConversion(
	target: MachineNameTarget,
	conversion: RestoreConversion,
	door: string,
): void {
	if (conversion.outcome === 'as_is' && conversion.flag === undefined) return;
	incrementCounter(`ontology_machine_name_restore_${conversion.outcome}`);
	if (conversion.outcome === 'ambiguous' || conversion.renamed) {
		console.warn(
			`[machine_name_save] ${door} ${target.sectionTipo}/${target.sectionId}: restore conversion ` +
				`${conversion.outcome}${conversion.renamed ? ' (the restore RENAMED the node — its published name changes)' : ''}; ` +
				`check ${NAME}/${FLAG}/${ONTOLOGY_TERM} with tool_ontology inspect`,
		);
	}
}

/** The key writes a conversion adds over `after` (ontology5 / ontology43 / ontology44). */
async function conversionWrites(
	conversion: RestoreConversion,
	after: Columns,
): Promise<MachineNameKeyWrite[]> {
	const writes: MachineNameKeyWrite[] = [];
	const push = async (key: string, value: unknown): Promise<void> => {
		const column = await columnOf(key);
		if (column !== null) writes.push({ column, key, value });
	};
	if (conversion.termItems !== undefined) {
		await push(ONTOLOGY_TERM, conversion.termItems.length > 0 ? conversion.termItems : null);
	}
	if (conversion.machineName !== undefined) {
		const existing = (await itemsOf(after, NAME))?.[0] as { id?: unknown } | undefined;
		const id = typeof existing?.id === 'number' ? existing.id : 1;
		await push(NAME, machineNameItems(conversion.machineName, id));
	}
	if (conversion.flag !== undefined) await push(FLAG, machineNameFlagItems(conversion.flag));
	return writes;
}

/** The conversion of a canonical `after` state against the node's `current` one. */
async function convertState(
	target: MachineNameTarget,
	current: Columns,
	after: Columns,
): Promise<RestoreConversion> {
	const state = await canonicalState(target, after);
	return convertRestoredMachineName({
		restored: {
			termItems: ((await itemsOf(after, ONTOLOGY_TERM)) ?? []) as StoredLiteralItem[],
			nameValues: state.nameValues,
			flag: state.flag,
		},
		current: {
			nameValues: literalStrings(await itemsOf(current, NAME)),
			flag: flagFromItems(await itemsOf(current, FLAG)),
		},
		nameClass: state.nameClass,
	});
}

/**
 * THE COMPONENT-RESTORE CONVERSION (persistRestoredKeys): the restored key
 * writes, plus whatever the conversion kernel adds or replaces. Call inside the
 * write's transaction. Out of scope / unarmed → the writes as given.
 */
export async function convertRestoredKeys<T extends MachineNameKeyWrite>(
	target: MachineNameTarget,
	writes: readonly T[],
	door: string,
): Promise<readonly T[]> {
	const scope = machineNameScope(
		target.sectionTipo,
		writes.map((write) => write.key),
	);
	if (scope !== 'canonical' || !(await machineNameComponentsDefined())) return writes;
	const current = await lockedColumns(target);
	const after = withKeyWrites(current, writes);
	const conversion = await convertState(target, current, after);
	reportConversion(target, conversion, door);
	const added = await conversionWrites(conversion, after);
	if (added.length === 0) return writes;
	const replaced = new Set(added.map((write) => write.key));
	return [...writes.filter((write) => !replaced.has(write.key)), ...(added as T[])];
}

/**
 * THE WHOLE-RECORD / BIRTH CONVERSION (persistRecordColumns, writeBirth): the
 * restored columns are rewritten IN PLACE (fresh column bags, the caller's are
 * never mutated). `live` = the row before the restore (null for a birth: the
 * snapshot is its own reference — see the module header).
 */
export async function convertRestoredColumns(
	target: MachineNameTarget,
	values: MatrixWriteValues,
	live: Columns | null,
	door: string,
): Promise<void> {
	if (machineNameScope(target.sectionTipo, columnKeysOf(values)) !== 'canonical') return;
	if (!(await machineNameComponentsDefined())) return;
	const after: Columns = { ...(live ?? {}), ...(values as Columns) };
	const conversion = await convertState(target, live ?? after, after);
	reportConversion(target, conversion, door);
	const writes = await conversionWrites(conversion, after);
	const converted = withKeyWrites(after, writes);
	for (const write of writes) {
		(values as Columns)[write.column] = converted[write.column];
	}
}

/** Every component key a whole-record payload carries, across its column bags. */
function columnKeysOf(values: MatrixWriteValues): string[] {
	return Object.values(values).flatMap((bag) => Object.keys(bagOf(bag) ?? {}));
}
