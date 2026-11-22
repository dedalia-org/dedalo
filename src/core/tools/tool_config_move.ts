/**
 * MOVE A VALUE INTO A TOOL'S CONFIGURATION — the door the v6→v7 config
 * migration uses for a v6 define whose v7 home is a tool-config key, not an
 * env key (src/config/migration_map.ts class `TOOL_CONFIG`; first and only
 * user: EXCLUDE_DIFFUSION_ELEMENTS → tool_diffusion, owner ruling 2026-11-22 R3).
 *
 * WHERE IT WRITES. The per-install layer `getToolConfigValue` reads first:
 * the Tools-configuration record (dd996) the READER names the tool's — its FIRST
 * name item (dd1326[0], `configRecordToolName`, the one rule config.ts reads
 * by) — and its config object in dd999 (core/tools/config.ts). Through the
 * engine's own write doors — `createSectionRecord` + `saveComponentData`, ONE
 * transaction, TM-audited, and the dd996 save event drops the tool-config
 * caches — never raw DML.
 *
 * ONE SHAPE RULE (review MED-2). The move carries `parse`, the READER's shape
 * rule for the key (`null` = malformed): the value to move must pass it (the
 * planner already left a malformed define out; this refuses one that reaches
 * the door anyway), and the stored value is judged by it too — v6 used either
 * only when `is_array` and silently ignored anything else.
 *
 * PRECEDENCE, the v6 one. v6 read the TOOL CONFIG first and fell back to the
 * define only when the tool config had no usable value
 * (`if (!$EXCLUDE_DIFFUSION_ELEMENTS)` — absent, null or an EMPTY list; a
 * non-array was ignored). So:
 *   - the define is empty                    → 'empty'    nothing written;
 *   - the record holds a non-empty value     → 'kept'     the define never applied;
 *   - the record exists, key absent/empty    → 'written'  merged into its config
 *                                                          (an `{value, …}` option keeps its metadata);
 *   - the record holds a MALFORMED value     → 'replaced' v6 ignored it and applied the define:
 *                                                          written over it, the old value REPORTED;
 *   - no record names the tool               → 'created'  a dd996 record for it.
 * REFUSED, nothing written: two records naming the tool (`resource.conflict` —
 * `readConfigMap` is last-wins, so writing into either would be a guess about
 * which one is live); a record whose stored config is not an OBJECT
 * (`tool.config_invalid`, naming the record — merging into it would silently
 * overwrite it as `{}`).
 */

import { sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import { configRecordToolName } from './config.ts';
import { TIPO, TOOLS_CONFIG_SECTION_TIPO } from './ontology_map.ts';

/** What a move did — the migration report prints it. */
export type ToolConfigMoveOutcome = 'empty' | 'kept' | 'written' | 'replaced' | 'created';

/** A move's outcome, the record it concerned, and what a 'replaced' overwrote. */
export interface ToolConfigMoveResult {
	readonly outcome: ToolConfigMoveOutcome;
	/** The dd996 record kept, written into, replaced into or created (absent for 'empty'). */
	readonly sectionId?: number;
	/** 'replaced' only — the malformed stored value the move wrote over. */
	readonly replaced?: unknown;
}

/** One move: `value` into `toolName`'s config under `key`, written as `userId`. */
export interface ToolConfigMove {
	readonly toolName: string;
	readonly key: string;
	readonly value: unknown;
	/** The READER's shape rule for `key`: the parsed list, or null when malformed. */
	readonly parse: (value: unknown) => unknown[] | null;
	readonly userId: number;
}

/** A value shown to an operator, bounded (a stored blob can be large). */
function shown(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** The effective value of a config option (`{value}` form → `.value`). */
function effectiveOption(option: unknown): unknown {
	return option !== null &&
		typeof option === 'object' &&
		!Array.isArray(option) &&
		'value' in option
		? (option as { value: unknown }).value
		: option;
}

/** The option to store: keep an `{value, …}` definition's metadata, else the bare value. */
function nextOption(previous: unknown, value: unknown): unknown {
	return previous !== null &&
		typeof previous === 'object' &&
		!Array.isArray(previous) &&
		'value' in previous
		? { ...(previous as Record<string, unknown>), value }
		: value;
}

async function saveConfigObject(
	sectionId: number,
	config: Record<string, unknown>,
	userId: number,
): Promise<void> {
	await saveOrThrow({
		componentTipo: TIPO.CONFIG,
		sectionId,
		value: [{ id: 1, value: config, lang: 'lg-nolan' }],
		userId,
	});
}

async function saveOrThrow(input: {
	componentTipo: string;
	sectionId: number;
	value: unknown[];
	userId: number;
}): Promise<void> {
	const result = await saveComponentData({
		componentTipo: input.componentTipo,
		sectionTipo: TOOLS_CONFIG_SECTION_TIPO,
		sectionId: input.sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', value: input.value }],
		userId: input.userId,
	});
	if (!result.ok) {
		throw new DedaloError('internal.invariant', {
			message: `tool config move: save of ${TOOLS_CONFIG_SECTION_TIPO}/${input.sectionId} ${input.componentTipo} refused: ${result.message}`,
			coordinates: { section_id: input.sectionId, component_tipo: input.componentTipo },
		});
	}
}

/** One dd996 record: its id, stored dd1326 name items and dd999 items. */
interface ConfigRow {
	section_id: number;
	name_items: { value?: unknown }[] | null;
	config_items: { value?: unknown }[] | null;
}

/**
 * The ONE dd996 record the READER names `toolName`'s (configRecordToolName —
 * dd1326[0], never an item further down), or null; two or more REFUSE.
 */
async function toolConfigRow(toolName: string): Promise<ConfigRow | null> {
	const rows = (await sql`
		SELECT section_id, string->${TIPO.NAME} AS name_items, misc->${TIPO.CONFIG} AS config_items
		FROM matrix_tools
		WHERE section_tipo = ${TOOLS_CONFIG_SECTION_TIPO}
		ORDER BY section_id
	`) as ConfigRow[];
	const named = rows.filter((row) => configRecordToolName(row.name_items) === toolName);
	if (named.length > 1) {
		throw new DedaloError('resource.conflict', {
			message: `tool config move: ${named.length} Tools-configuration records name '${toolName}'`,
			publicMessage: `Several Tools configuration (dd996) records configure '${toolName}' (${named.map((row) => row.section_id).join(', ')}). Keep one, then run the migration again. Nothing was written.`,
			coordinates: { tool: toolName },
		});
	}
	return named[0] ?? null;
}

/** A new dd996 record for the tool, holding only the moved key. Answers its id. */
async function createToolConfigRecord(move: ToolConfigMove): Promise<number> {
	const sectionId = await createSectionRecord(TOOLS_CONFIG_SECTION_TIPO, move.userId);
	await saveOrThrow({
		componentTipo: TIPO.NAME,
		sectionId,
		value: [{ id: 1, value: move.toolName, lang: 'lg-nolan' }],
		userId: move.userId,
	});
	await saveConfigObject(sectionId, { [move.key]: move.value }, move.userId);
	return sectionId;
}

/**
 * The stored config object of a record: none stored reads as `{}`; anything
 * that is not an object REFUSES, naming the record — merging into it would
 * overwrite it as `{}` without a word (review MED-2).
 */
function configObjectOf(row: ConfigRow, toolName: string): Record<string, unknown> {
	const stored = row.config_items?.[0]?.value;
	if (stored === undefined || stored === null) return {};
	if (typeof stored === 'object' && !Array.isArray(stored))
		return stored as Record<string, unknown>;
	throw new DedaloError('tool.config_invalid', {
		message: `tool config move: ${TOOLS_CONFIG_SECTION_TIPO}/${row.section_id} ${TIPO.CONFIG} is not a config object: ${shown(stored)}`,
		publicMessage: `The Tools configuration (dd996) record ${row.section_id} of '${toolName}' holds a configuration that is not an object (${shown(stored)}). Fix or remove it, then run the migration again. Nothing was written.`,
		coordinates: { section_id: row.section_id, tool: toolName },
	});
}

/** The move inside its transaction (see the module header for the outcomes). */
async function moveIntoRecord(move: ToolConfigMove): Promise<ToolConfigMoveResult> {
	const row = await toolConfigRow(move.toolName);
	if (row === null) return { outcome: 'created', sectionId: await createToolConfigRecord(move) };
	const sectionId = Number(row.section_id);
	const config = configObjectOf(row, move.toolName);
	const previous = config[move.key];
	const stored = move.parse(effectiveOption(previous));
	if (stored !== null && stored.length > 0) return { outcome: 'kept', sectionId };
	await saveConfigObject(
		sectionId,
		{ ...config, [move.key]: nextOption(previous, move.value) },
		move.userId,
	);
	return stored === null
		? { outcome: 'replaced', sectionId, replaced: effectiveOption(previous) }
		: { outcome: 'written', sectionId };
}

/** Move `value` into the tool's install config (see the module header for the outcomes). */
export async function moveValueIntoToolConfig(move: ToolConfigMove): Promise<ToolConfigMoveResult> {
	const moved = move.parse(move.value);
	if (moved === null) {
		throw new DedaloError('tool.config_invalid', {
			message: `tool config move: the value for ${move.toolName} '${move.key}' is malformed: ${shown(move.value)}`,
			publicMessage: `The value to move into the ${move.toolName} configuration '${move.key}' is not the shape it is read as (${shown(move.value)}). Nothing was written.`,
			coordinates: { tool: move.toolName, key: move.key },
		});
	}
	if (moved.length === 0) return { outcome: 'empty' };
	return withTransaction(() => moveIntoRecord(move));
}
