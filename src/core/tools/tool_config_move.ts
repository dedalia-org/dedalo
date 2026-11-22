/**
 * MOVE A VALUE INTO A TOOL'S CONFIGURATION — the door the v6→v7 config
 * migration uses for a v6 define whose v7 home is a tool-config key, not an
 * env key (src/config/migration_map.ts class `TOOL_CONFIG`; first and only
 * user: EXCLUDE_DIFFUSION_ELEMENTS → tool_diffusion, owner ruling 2026-11-22 R3).
 *
 * WHERE IT WRITES. The per-install layer `getToolConfigValue` reads first:
 * the Tools-configuration record (dd996) whose name (dd1326) is the tool, its
 * config object in dd999 (core/tools/config.ts). Through the engine's own write
 * doors — `createSectionRecord` + `saveComponentData`, ONE transaction, TM-audited,
 * and the dd996 save event drops the tool-config caches — never raw DML.
 *
 * PRECEDENCE, the v6 one. v6 read the TOOL CONFIG first and fell back to the
 * define only when the tool config had no usable value
 * (`if (!$EXCLUDE_DIFFUSION_ELEMENTS)` — absent, null or an EMPTY list). So:
 *   - the define is empty                    → 'empty'   nothing written;
 *   - the record holds a non-empty value     → 'kept'    the define never applied;
 *   - the record exists, key absent/empty    → 'written' merged into its config
 *                                                         (an `{value, …}` option keeps its metadata);
 *   - no record names the tool               → 'created' a dd996 record for it.
 * Two records naming the tool REFUSE (`resource.conflict`): `readConfigMap` is
 * last-wins, so writing into either would be a guess about which one is live.
 */

import { sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import { TIPO, TOOLS_CONFIG_SECTION_TIPO } from './ontology_map.ts';

/** What a move did — the migration report prints it. */
export type ToolConfigMoveOutcome = 'empty' | 'kept' | 'written' | 'created';

/** One move: `value` into `toolName`'s config under `key`, written as `userId`. */
export interface ToolConfigMove {
	readonly toolName: string;
	readonly key: string;
	readonly value: unknown;
	readonly userId: number;
}

/** No usable value — what v6's `!$value` treated as "fall back". */
function isEmptyValue(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === '' ||
		(Array.isArray(value) && value.length === 0)
	);
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

/** One dd996 record naming the tool: its id and stored dd999 items. */
interface ConfigRow {
	section_id: number;
	config_items: { value?: unknown }[] | null;
}

/** The ONE dd996 record naming `toolName`, or null; two or more REFUSE. */
async function toolConfigRow(toolName: string): Promise<ConfigRow | null> {
	const rows = (await sql`
		SELECT section_id, misc->${TIPO.CONFIG} AS config_items
		FROM matrix_tools
		WHERE section_tipo = ${TOOLS_CONFIG_SECTION_TIPO}
			AND string->${TIPO.NAME} @> ${JSON.stringify([{ value: toolName }])}::text::jsonb
		ORDER BY section_id
	`) as ConfigRow[];
	if (rows.length > 1) {
		throw new DedaloError('resource.conflict', {
			message: `tool config move: ${rows.length} Tools-configuration records name '${toolName}'`,
			publicMessage: `Several Tools configuration (dd996) records configure '${toolName}' (${rows.map((row) => row.section_id).join(', ')}). Keep one, then run the migration again. Nothing was written.`,
			coordinates: { tool: toolName },
		});
	}
	return rows[0] ?? null;
}

/** A new dd996 record for the tool, holding only the moved key. */
async function createToolConfigRecord(move: ToolConfigMove): Promise<void> {
	const sectionId = await createSectionRecord(TOOLS_CONFIG_SECTION_TIPO, move.userId);
	await saveOrThrow({
		componentTipo: TIPO.NAME,
		sectionId,
		value: [{ id: 1, value: move.toolName, lang: 'lg-nolan' }],
		userId: move.userId,
	});
	await saveConfigObject(sectionId, { [move.key]: move.value }, move.userId);
}

/** The stored config object of a record (anything else reads as empty). */
function configObjectOf(row: ConfigRow): Record<string, unknown> {
	const stored = row.config_items?.[0]?.value;
	return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
		? (stored as Record<string, unknown>)
		: {};
}

/** Move `value` into the tool's install config (see the module header for the outcomes). */
export async function moveValueIntoToolConfig(
	move: ToolConfigMove,
): Promise<ToolConfigMoveOutcome> {
	if (isEmptyValue(move.value)) return 'empty';
	return withTransaction(async () => {
		const row = await toolConfigRow(move.toolName);
		if (row === null) {
			await createToolConfigRecord(move);
			return 'created';
		}
		const config = configObjectOf(row);
		const previous = config[move.key];
		if (!isEmptyValue(effectiveOption(previous))) return 'kept';
		await saveConfigObject(
			Number(row.section_id),
			{ ...config, [move.key]: nextOption(previous, move.value) },
			move.userId,
		);
		return 'written';
	});
}
