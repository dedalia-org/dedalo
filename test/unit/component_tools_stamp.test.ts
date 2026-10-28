/**
 * The component/area TOOLBAR stamp (PHP common::build_structure_context
 * :1857-1866 — the `$tools` block, fed by common::get_tools).
 *
 * PHP gates that block on **mode**, never on permissions:
 *
 *   if ($simple===false &&
 *       ((($model==='section' || str_starts_with($model,'area')) && $this->mode==='list')
 *        || ($this->mode!=='list')))
 *
 * i.e. a component gets its toolbar in every mode EXCEPT list; a section/area
 * gets one in every mode including list. `common::get_tools()` itself
 * (class.common.php:4023) contains no permission check at all — authorization
 * is the per-user `get_user_tools()` list it iterates, not the element's level.
 *
 * The TS port instead gated on `permissions >= 3`. Only the SUPERUSER ever
 * reaches 3 (`getPermissions` short-circuits userId -1; the profile matrix tops
 * out at 2 — a global admin included), so EVERY non-root user received
 * `tools: []` on every component and area. The user-visible symptom was
 * tool_user_admin: its dd522 avatar is rendered with `show_interface.tools:true`
 * and the image is uploaded FROM that toolbar (tool_upload), so a non-root user
 * could never upload their own picture.
 *
 * The frozen oracle proves the mode rule and refutes the permission gate —
 * PHP shipped tools at levels BELOW 3:
 *   sqo_differential.json               dd560 component_dataframe   edit perm 2 -> [tool_time_machine]
 *   tm_component_history_differential   dd452 component_input_text  tm   perm 1 -> [tool_propagate_component_data, tool_time_machine]
 * and never shipped them for a component in list mode.
 */

import { describe, expect, test } from 'bun:test';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { invalidateAllToolCaches } from '../../src/core/tools/cache.ts';
import { PROFILE_SECTION_TIPO } from '../../src/core/tools/ontology_map.ts';
import {
	getElementTools,
	getProfileGrantedToolIds,
	getUserTools,
} from '../../src/core/tools/registry.ts';

/** The dd128 user avatar — tool_user_admin's uploadable component. */
const USER_IMAGE_TIPO = 'dd522';
const USERS_SECTION = 'dd128';
/** Profile-8 non-admin fixture user (the standing menu_nonadmin fixture). */
const NON_ADMIN_USER = 16;

async function toolNamesOf(
	tipo: string,
	sectionTipo: string,
	mode: string,
	permissions: number,
	simple = false,
): Promise<string[]> {
	const entry = await buildStructureContext({
		tipo,
		sectionTipo,
		mode,
		lang: 'lg-nolan',
		permissions,
		// addRequestConfig===false IS the port's marker for PHP's $simple.
		addRequestConfig: !simple,
	});
	expect(entry).not.toBeNull();
	return ((entry?.tools ?? []) as { name?: string }[]).map((tool) => String(tool.name));
}

describe('component toolbar stamp is gated on MODE, not on permissions', () => {
	test('the dd522 avatar carries its toolbar at permissions 2 — tool_user_admin uploads from it', async () => {
		// The registry filter is the oracle for WHICH tools belong on dd522.
		const expected = await getElementTools({
			model: 'component_image',
			tipo: USER_IMAGE_TIPO,
			isComponent: true,
			translatable: false,
			toolConfigKeys: [],
		});
		expect(expected.ledgered).toEqual([]);
		const expectedNames = expected.tools.map((tool) => tool.name);
		// The upload tool is the one the avatar needs; assert it explicitly so a
		// registry change that drops it fails HERE and not in the browser.
		expect(expectedNames).toContain('tool_upload');

		// permissions 2 is what EVERY non-superuser gets on their own record
		// (resolveOwnUserRecordPermission forces exactly 2 for dd522).
		expect(await toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'edit', 2)).toEqual(expectedNames);
	});

	test('tool_transcription only where the element configures it (crawl #7: null roles crashed)', async () => {
		const names = async (toolConfigKeys: string[]) =>
			(
				await getElementTools({
					model: 'component_image',
					tipo: USER_IMAGE_TIPO,
					isComponent: true,
					translatable: false,
					toolConfigKeys,
				})
			).tools.map((tool) => tool.name);
		// a bare image (the avatar) — no tool_config.tool_transcription, no roles
		expect(await names([])).not.toContain('tool_transcription');
		// the same model WITH the config (rsc29/rsc35/rsc37 shape) keeps it
		expect(await names(['tool_transcription'])).toContain('tool_transcription');
	});

	test('permissions do not decide the toolbar — level 1 in a non-list mode still gets one', async () => {
		// PHP fixture: dd452 at permissions 1 (mode 'tm') shipped two tools.
		const tools = await toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'edit', 1);
		expect(tools.length).toBeGreaterThan(0);
	});

	test('a component in LIST mode has no toolbar (the one PHP exclusion)', async () => {
		expect(await toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'list', 3)).toEqual([]);
	});

	test('the list-mode exclusion STAYS — the per-cell edit modal is the supported route', async () => {
		// Read this before "fixing" list mode on the server. The same component, the
		// same section, the same permissions: list is empty by contract, edit is not.
		// A user reaching a component tool from a section LIST does it by clicking
		// the cell (component_common activate_edit_in_list → ui.render_edit_modal),
		// which builds a FRESH instance at mode 'edit' and does a real read — so it
		// lands on the branch below and gets a full toolbar, with no server change.
		//
		// Stamping tools in list mode instead would be wrong three times over: it is
		// oracle-pinned (PHP never shipped them for a component in list mode), it
		// would put a toolbar in every grid cell, and it would not even work —
		// tool_common takes main_element.mode from the CALLER, so the propagate
		// tool's editable clone would render as a read-only list cell with nothing
		// to type into.
		const inList = await toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'list', 3);
		const inEdit = await toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'edit', 3);
		expect(inList).toEqual([]);
		expect(inEdit.length).toBeGreaterThan(0);
	});

	test('a SECTION keeps its toolbar at permissions 2, in list AND edit mode', async () => {
		// PHP fixture: section contexts ship tools in list ('dd15' → tool_export),
		// edit and related_list. Only the `start` (simple) builds are empty.
		for (const mode of ['list', 'edit']) {
			const tools = await toolNamesOf(USERS_SECTION, USERS_SECTION, mode, 2);
			expect(tools.length).toBeGreaterThan(0);
		}
	});

	test('a SIMPLE build ships no toolbar — PHP get_structure_context_simple', async () => {
		// The start action and the search-filter panel take this path; the frozen
		// start fixture ships `tools: []` on its section context.
		expect(await toolNamesOf(USERS_SECTION, USERS_SECTION, 'list', 3, true)).toEqual([]);
		expect(await toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'edit', 3, true)).toEqual([]);
	});

	test('a toolbar never offers a tool the actor’s PROFILE does not grant', async () => {
		// PHP get_tools iterates get_user_tools($user_id). Dropping the old
		// permission gate un-masked this: without the user_tools membership check
		// a non-admin would receive tool contexts their profile denies (harmless
		// to click — every tool door re-authorizes — but wrong on the wire and a
		// parity divergence). Expectations are DERIVED from getUserTools, so the
		// test states the RULE, not one install's grant list.
		const nonAdmin: Principal = {
			userId: NON_ADMIN_USER,
			isGlobalAdmin: false,
			isDeveloper: false,
		};
		const authorized = new Set((await getUserTools(nonAdmin.userId, false)).map((t) => t.name));

		const unfiltered = await getElementTools({
			model: 'component_image',
			tipo: USER_IMAGE_TIPO,
			isComponent: true,
			translatable: false,
			toolConfigKeys: [],
		});
		// Only meaningful if this element DOES offer something they lack.
		const denied = unfiltered.tools.map((t) => t.name).filter((name) => !authorized.has(name));
		expect(denied.length).toBeGreaterThan(0);

		const seen = await runWithRequestContext(
			{ principal: nonAdmin, session: null, requestId: 'test', clientIp: '127.0.0.1' },
			async () => toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'edit', 2),
		);
		// The filter demonstrably FIRED (not vacuously green): strictly fewer
		// tools than the unfiltered element list, and nothing denied survived.
		expect(seen.length).toBeLessThan(unfiltered.tools.length);
		for (const name of seen) expect(authorized.has(name)).toBe(true);
		for (const name of denied) expect(seen).not.toContain(name);

		// ...the SUPERUSER in the same scope keeps the full list, so the filter is
		// the profile, not a blanket suppression…
		const scoped = (principal: Principal) =>
			runWithRequestContext(
				{ principal, session: null, requestId: 'test', clientIp: '127.0.0.1' },
				async () => toolNamesOf(USER_IMAGE_TIPO, USERS_SECTION, 'edit', 2),
			);
		expect(await scoped({ userId: -1, isGlobalAdmin: true, isDeveloper: true })).toEqual(
			unfiltered.tools.map((t) => t.name),
		);
		// …and the GLOBAL-ADMIN FLAG widens nothing (closure Step 3 req 8 — the
		// same rule as getUserTools and the dispatcher's gate 4): the same user
		// claiming admin sees exactly what its profile grants. Before req 8 this
		// stamp opened with `isGlobalAdmin → no filter`, offering every tool the
		// dispatcher then refused.
		expect(await scoped({ ...nonAdmin, isGlobalAdmin: true })).toEqual(seen);
	});

	test('the per-user grants cache is dropped by BOTH invalidation channels', async () => {
		// getUserTools reads through that cache and IS a security gate
		// (tools/dispatch Gate 4), so a stale entry would keep a REVOKED tool
		// usable. Two routes must clear it: the save-event channel (any dd128
		// profile-assignment or dd234 grant write, registered by construction via
		// createDataCache) and the documented single entry point.
		// Cache IDENTITY is the observable signal (the same trick the existing
		// tools_cache_invalidation gate uses): the Set is memoized per user, so
		// the SAME object comes back until something clears it. Comparing values
		// would pass whether or not the cache was dropped.
		const cached = await getProfileGrantedToolIds(NON_ADMIN_USER);
		expect(await getProfileGrantedToolIds(NON_ADMIN_USER)).toBe(cached); // memoized

		// A write to an UNRELATED section must NOT clear it (no over-eviction).
		await fireSaveEvent('test3');
		expect(await getProfileGrantedToolIds(NON_ADMIN_USER)).toBe(cached);

		// Each real channel must reach it. If any stops clearing, a REVOKED grant
		// would stay usable until the process restarts.
		for (const [label, clear] of [
			['dd128 — profile ASSIGNMENT changed', () => fireSaveEvent(USERS_SECTION)],
			['dd234 — the GRANTS changed', () => fireSaveEvent(PROFILE_SECTION_TIPO)],
			['the documented single entry point', async () => invalidateAllToolCaches()],
		] as [string, () => Promise<unknown>][]) {
			const before = await getProfileGrantedToolIds(NON_ADMIN_USER);
			await clear();
			const after = await getProfileGrantedToolIds(NON_ADMIN_USER);
			expect({ label, rebuilt: after !== before }).toEqual({ label, rebuilt: true });
			expect([...after]).toEqual([...before]); // same DB truth, fresh object
		}
	});

	test('an AREA keeps its toolbar in list mode (the section/area clause)', async () => {
		const areaTipo = 'dd5'; // ontology area — tool_ontology_parser's affected tipo
		const expected = await getElementTools({
			model: 'area_ontology',
			tipo: areaTipo,
			isComponent: false,
			translatable: false,
			toolConfigKeys: [],
		});
		if (expected.tools.length === 0) return; // no area tool bound in this corpus
		const names = expected.tools.map((tool) => tool.name);
		expect(await toolNamesOf(areaTipo, areaTipo, 'list', 2)).toEqual(names);
	});
});
