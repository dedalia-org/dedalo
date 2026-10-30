/**
 * THE UNFILTERED user_tools LIST BELONGS TO THE SUPERUSER ID ALONE
 * (audit 2026-08 OH1 finding 5, restored 2026-08-09).
 *
 * PHP's only unfiltered branch is `if ($user_id == DEDALO_SUPERUSER)` —
 * tools/tool_common/class.tool_common.php:1403. There is no admin FLAG in that
 * decision: a global admin whose profile does not grant a tool does not get it,
 * exactly like anyone else, at every door (the menu entry, the section button
 * bar, dd_tools_api, the tool dispatcher's Gate 4, the oh media-icons widget).
 *
 * The port opened `getUserTools` with `if (isGlobalAdmin) return
 * getSuperuserUserTools()`, so SIX of its seven call sites over-granted every
 * non-superuser global admin. Only menu.ts had been fixed, and only in
 * isolation — by passing a hardcoded `userId === SUPERUSER_ID` instead of the
 * caller's flag, which is why that door alone was correct.
 *
 * THIS GATE IS THE RULE, NOT ONE DOOR'S WIRING: it asserts the flag cannot
 * WIDEN the list whatever a caller passes, and that the identity alone decides.
 * The second parameter survives only so the remaining call sites still compile
 * while they are cleaned up; it is inert, and test 3 proves that dropping it is
 * a behaviour-free edit.
 *
 * Needs the DB (the registry + profile tables). Expectations are DERIVED, never
 * hardcoded, so the gate holds as the install's grants evolve.
 */

import { describe, expect, test } from 'bun:test';
import { aiCapabilities, toolOfferedByCapabilities } from '../../src/ai/capabilities.ts';
import { SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { getSuperuserUserTools, getUserTools } from '../../src/core/tools/registry.ts';

/**
 * The superuser's list AS getUserTools offers it: the raw registry minus the AI
 * tools hidden on this deployment (src/ai/capabilities.ts). The raw
 * getSuperuserUserTools() is unchanged; the hiding is applied once in getUserTools.
 */
async function offeredSuperuserTools() {
	const capabilities = aiCapabilities();
	const all = await getSuperuserUserTools();
	return all.filter((tool) => toolOfferedByCapabilities(tool.name, capabilities));
}

/** The standing non-superuser fixture user (profile-granted a real subset). */
const NON_ADMIN_USER = 16;

describe('user_tools: the admin flag cannot widen the list', () => {
	test('a non-superuser gets the SAME tools whether or not the caller claims admin', async () => {
		const asAdmin = await getUserTools(NON_ADMIN_USER, true);
		const asPlain = await getUserTools(NON_ADMIN_USER, false);
		expect(asAdmin).toEqual(asPlain);

		// Anti-vacuity: the fixture user must really be filtered, in both
		// directions — a profile that granted everything, or nothing, would make
		// the equality above true without proving anything.
		const all = await getSuperuserUserTools();
		expect(asAdmin.length).toBeGreaterThan(0);
		expect(asAdmin.length).toBeLessThan(all.length);
	});

	test('the SUPERUSER ID alone grants the unfiltered list — no flag required', async () => {
		const superuser = await offeredSuperuserTools();
		// `false` is what a caller reading a session with no admin flag passes;
		// the identity is what decides.
		expect(await getUserTools(SUPERUSER_ID, false)).toEqual(superuser);
		expect(await getUserTools(SUPERUSER_ID, true)).toEqual(superuser);
	});

	test('the flag is inert when OMITTED too (the call-site cleanup is behaviour-free)', async () => {
		// The handoff deletes the second argument at the six call sites that pass
		// `principal.isGlobalAdmin`. This pins that the deletion changes nothing.
		expect(await getUserTools(NON_ADMIN_USER)).toEqual(await getUserTools(NON_ADMIN_USER, false));
		expect(await getUserTools(SUPERUSER_ID)).toEqual(await offeredSuperuserTools());
	});
});
