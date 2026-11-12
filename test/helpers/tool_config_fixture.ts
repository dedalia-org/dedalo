/**
 * A SCRATCH Tools-configuration record (dd996, matrix_tools) for one tool — the
 * install-config layer `getToolConfig` reads per key over the register default
 * (src/core/tools/config.ts). It lets a gate drive a tool whose behaviour comes
 * from SERVER config (T1-6: tool_import_marc21's map) with a config it built,
 * instead of whatever the ambient database holds.
 *
 * The row is install-global state in the marked suite database, so it is
 * created ONLY there (`assertTestDatabase`), refused when any OTHER dd996
 * record already names the tool (`readConfigMap` is last-wins, so a second row
 * would make the effective config ambiguous), and always swept.
 *
 * Direct DML, on the precedent of tool_transcription.test.ts: dd996 is a
 * matrix_tools config row with no TM or counter meaning for these gates, and
 * the address is the scratch id this helper owns and deletes first.
 */

import { sql } from '../../src/core/db/postgres.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { resetConfigCache } from '../../src/core/tools/config.ts';

/** The dd996 record this helper owns (deleted before every install and after). */
const SCRATCH_CONFIG_ID = 990071;

async function deleteScratchRow(): Promise<void> {
	await sql`DELETE FROM matrix_tools WHERE section_tipo = 'dd996' AND section_id = ${SCRATCH_CONFIG_ID}`;
}

/**
 * Install `config` as `toolName`'s Tools configuration. Answers the teardown
 * (row deleted, config cache reset). Replaces any scratch config this helper
 * installed before.
 */
export async function installScratchToolConfig(
	toolName: string,
	config: Record<string, unknown>,
): Promise<() => Promise<void>> {
	await assertTestDatabase('installScratchToolConfig');
	await deleteScratchRow();
	const others = (await sql`
		SELECT section_id FROM matrix_tools
		WHERE section_tipo = 'dd996' AND string->'dd1326' @> ${JSON.stringify([{ value: toolName }])}::text::jsonb
	`) as { section_id: number }[];
	if (others.length > 0) {
		throw new Error(
			`installScratchToolConfig: dd996 record(s) ${others.map((r) => r.section_id).join(', ')} already configure '${toolName}' in the suite database — the scratch config would be ambiguous. Nothing was written.`,
		);
	}
	await sql`
		INSERT INTO matrix_tools (section_id, section_tipo, string, misc)
		VALUES (
			${SCRATCH_CONFIG_ID},
			'dd996',
			${JSON.stringify({ dd1326: [{ id: 1, value: toolName }] })}::text::jsonb,
			${JSON.stringify({ dd999: [{ id: 1, value: config }] })}::text::jsonb
		)`;
	resetConfigCache();
	return async () => {
		await deleteScratchRow();
		resetConfigCache();
	};
}

/** Run `fn` with `config` installed as `toolName`'s Tools configuration, swept after. */
export async function withScratchToolConfig<T>(
	toolName: string,
	config: Record<string, unknown>,
	fn: () => Promise<T>,
): Promise<T> {
	const teardown = await installScratchToolConfig(toolName, config);
	try {
		return await fn();
	} finally {
		await teardown();
	}
}
