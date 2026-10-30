/**
 * Phase 6 gate: the NON-ADMIN user_tools filter (PHP tool_common::
 * get_user_tools non-superuser path) — profile-granted tools (the dd234
 * profile record's dd1067 locators into the dd1324 registry) plus tools
 * flagged always_active (dd1601). Expectations are DERIVED FROM THE LIVE DB
 * (not hardcoded), so the gate holds as the registry/profile data evolves.
 */

import { describe, expect, test } from 'bun:test';
import { aiCapabilities, toolOfferedByCapabilities } from '../../src/ai/capabilities.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getSuperuserUserTools, getUserTools } from '../../src/core/tools/registry.ts';

/** The standing non-admin fixture user (profile 8 on the mib DB). */
const NON_ADMIN_USER = 16;

/** The DB-derived expected tool names for one user (the PHP filter, in SQL). */
async function expectedToolNames(userId: number): Promise<Set<string>> {
	const rows = (await sql.unsafe(
		`SELECT t.string->'dd1326'->0->>'value' AS name
		 FROM matrix_tools t
		 WHERE t.section_tipo = 'dd1324'
		   AND t.relation->'dd1354' @> '[{"section_id":"1","section_tipo":"dd64"}]'
		   AND (
			 t.relation->'dd1601' @> '[{"section_id":"1","section_tipo":"dd64"}]'
			 OR t.section_id IN (
				SELECT (grant_item->>'section_id')::int
				FROM matrix_profiles p,
					 jsonb_array_elements(COALESCE(p.relation->'dd1067', '[]'::jsonb)) AS grant_item
				WHERE p.section_tipo = 'dd234'
				  AND grant_item->>'section_tipo' = 'dd1324'
				  AND p.section_id = (
					SELECT (u.relation->'dd1725'->0->>'section_id')::int
					FROM matrix_users u WHERE u.section_id = $1
				  )
			 )
		   )`,
		[userId],
	)) as { name: string | null }[];
	return new Set(rows.map((row) => row.name).filter((name): name is string => name !== null));
}

describe('non-admin user_tools filter (Phase 6 gate)', () => {
	test('a non-admin receives exactly the profile grants + always_active tools', async () => {
		const expected = await expectedToolNames(NON_ADMIN_USER);
		const tools = await getUserTools(NON_ADMIN_USER, false);
		expect(new Set(tools.map((tool) => tool.name))).toEqual(expected);
		// The fixture user must see FEWER tools than the superuser (a real filter).
		const all = await getSuperuserUserTools();
		expect(tools.length).toBeLessThan(all.length);
		expect(tools.length).toBeGreaterThan(0); // always_active floor
	});

	test('a user with NO profile gets only the always_active floor (fail-closed)', async () => {
		const tools = await getUserTools(999999, false);
		const alwaysActive = (await sql.unsafe(
			`SELECT string->'dd1326'->0->>'value' AS name FROM matrix_tools
			 WHERE section_tipo = 'dd1324'
			   AND relation->'dd1354' @> '[{"section_id":"1","section_tipo":"dd64"}]'
			   AND relation->'dd1601' @> '[{"section_id":"1","section_tipo":"dd64"}]'`,
			[],
		)) as { name: string | null }[];
		expect(new Set(tools.map((tool) => tool.name))).toEqual(
			new Set(alwaysActive.map((row) => row.name).filter((name): name is string => name !== null)),
		);
	});

	test('the admin path is every active tool the AI capabilities offer', async () => {
		const viaFilter = await getUserTools(-1, true);
		const superuser = await getSuperuserUserTools();
		// The capability filter (src/ai/capabilities.ts) applies to root too: a hidden
		// AI tool is neither offered nor granted to anyone. tool_identify is withdrawn
		// until its redesign (WC-2026-10-29-ai-capabilities-page-globals, addendum).
		const capabilities = aiCapabilities();
		expect(viaFilter).toEqual(
			superuser.filter((tool) => toolOfferedByCapabilities(tool.name, capabilities)),
		);
		expect(superuser.some((tool) => tool.name === 'tool_identify')).toBe(true);
		expect(viaFilter.some((tool) => tool.name === 'tool_identify')).toBe(false);
	});
});
