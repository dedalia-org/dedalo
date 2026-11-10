/**
 * THE READ DOOR OF `dd_component_info:get_widget_data`
 * (WC-2026-11-10-widget-data-read-door; T0-3 S12 residue, owner decision
 * 2026-11-10: CLOSE).
 *
 * PHP had NO gate on this action (frozen class.dd_component_info.php): any
 * logged-in user computed any widget over any record it named. TS used to gate
 * the RECORD scope only. The door now is the write door's READ mode
 * (write_door.authorizeRecordAccess): section >= 1 → the info component's own
 * pair grant → record scope; a non-address section_id is refused BY NAME. The
 * widget's `ipo` inputs pass "as displayed" — no persona here holds a grant on
 * the input component (test52), and the control is still served its value.
 *
 * Every refusal is a PAIR (test/helpers/widget_data_door_fixture.ts): READER and
 * CONTROL identical (non-admin, same project, same filter grant) except the
 * ONE grant under test, the control served the EXACT body on the same call.
 *
 *   (a) no section grant, record in scope   → perm.denied   / control served
 *   (b) section granted, info component 0   → perm.denied   / control served
 *   (c) record out of scope                 → perm.out_of_scope / superuser served
 *   (d) non-integer / non-address section_id → request.invalid_source (by name)
 *
 * Situation: the generic `test` TLD's own test3 + test212 (component_info with
 * the test_info widget over test52) — repo-owned ontology, no node written;
 * records and personas minted at runtime in band 937400-937499, swept after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { componentInfoApiActions } from '../../src/core/api/handlers/dd_component_info.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	type Principal,
	resolvePrincipal,
	SUPERUSER_ID,
} from '../../src/core/security/permissions.ts';
import type { Session } from '../../src/core/security/session_store.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	IN_SCOPE_RECORD_ID,
	IN_SCOPE_VALUE,
	installWidgetDataDoorFixture,
	OUT_OF_SCOPE_RECORD_ID,
	OUT_OF_SCOPE_VALUE,
	removeWidgetDataDoorFixture,
	WIDGET_CONTROL_USER_ID,
	WIDGET_INFO,
	WIDGET_NAME,
	WIDGET_NO_COMPONENT_USER_ID,
	WIDGET_NO_SECTION_USER_ID,
	WIDGET_SECTION,
} from '../helpers/widget_data_door_fixture.ts';

const ACTION = 'get_widget_data';
const getWidgetData = mustGet(componentInfoApiActions[ACTION], `${ACTION} handler`);

const contextFor = (principal: Principal): ApiRequestContext => ({
	requestId: 'widget-data-read-door',
	clientIp: '127.0.0.1',
	session: {
		userId: principal.userId,
		username: `zzwidget_${principal.userId}`,
		isGlobalAdmin: principal.isGlobalAdmin,
		csrfToken: 'x',
		applicationLang: null,
		dataLang: null,
	} as Session,
	csrfCandidate: null,
	principal,
});

const rqoFor = (sectionId: unknown): Rqo =>
	({
		action: ACTION,
		dd_api: 'dd_component_info',
		source: {
			tipo: WIDGET_INFO,
			section_tipo: WIDGET_SECTION,
			section_id: sectionId,
			mode: 'edit',
		},
		options: { widget_name: WIDGET_NAME },
	}) as unknown as Rqo;

/** The EXACT success body: test_info emits one item per output id, the value of test52. */
const servedBody = (value: string) => ({
	ok: true,
	request_id: 'widget-data-read-door',
	data: [
		{ widget: 'test_info', key: 0, widget_id: 'test_value', id: 'test_value', value },
		{ widget: 'test_info', key: 0, widget_id: 'test_label', id: 'test_label', value },
	],
});

/** The refusal THROWN by the handler (the dispatch chokepoint converts it). */
async function refusalOf(call: Promise<unknown>): Promise<DedaloError> {
	const outcome = await call.then(
		(value) => ({ threw: false as const, value }),
		(error: unknown) => ({ threw: true as const, error }),
	);
	if (!outcome.threw) throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
	if (!(outcome.error instanceof DedaloError)) throw outcome.error;
	return outcome.error;
}

let control: Principal;
let noSection: Principal;
let noComponent: Principal;
let superuser: Principal;

beforeAll(async () => {
	await installWidgetDataDoorFixture();
	control = await resolvePrincipal(WIDGET_CONTROL_USER_ID);
	noSection = await resolvePrincipal(WIDGET_NO_SECTION_USER_ID);
	noComponent = await resolvePrincipal(WIDGET_NO_COMPONENT_USER_ID);
	superuser = await resolvePrincipal(SUPERUSER_ID);
});

afterAll(async () => {
	await removeWidgetDataDoorFixture();
});

describe(`${ACTION} — the read door, paired`, () => {
	test('the personas are what the fixture claims: non-admin, one project, same identity shape', () => {
		for (const principal of [control, noSection, noComponent]) {
			expect(principal.isGlobalAdmin).toBe(false);
			expect(principal.isDeveloper).toBe(false);
		}
		expect(superuser.userId).toBe(SUPERUSER_ID);
	});

	test('(a) no SECTION grant, record in scope ⇒ perm.denied; the control is served (input "as displayed")', async () => {
		const refusal = await refusalOf(
			getWidgetData(rqoFor(IN_SCOPE_RECORD_ID), contextFor(noSection)),
		);
		expect(refusal.code).toBe('perm.denied');
		expect(refusal.spec.status).toBe(403);
		expect(refusal.message).toContain('section grant');

		const served = await getWidgetData(rqoFor(IN_SCOPE_RECORD_ID), contextFor(control));
		expect(served.status).toBe(200);
		expect(served.body as unknown).toEqual(servedBody(IN_SCOPE_VALUE));
	});

	test('(b) section granted, INFO COMPONENT 0 ⇒ perm.denied; the control is served', async () => {
		const refusal = await refusalOf(
			getWidgetData(rqoFor(IN_SCOPE_RECORD_ID), contextFor(noComponent)),
		);
		expect(refusal.code).toBe('perm.denied');
		expect(refusal.spec.status).toBe(403);
		expect(refusal.message).toContain(`no read grant on (${WIDGET_SECTION}, ${WIDGET_INFO})`);

		const served = await getWidgetData(rqoFor(IN_SCOPE_RECORD_ID), contextFor(control));
		expect(served.body as unknown).toEqual(servedBody(IN_SCOPE_VALUE));
	});

	test('(c) record OUT of scope ⇒ perm.out_of_scope for the control; the superuser is served', async () => {
		const refusal = await refusalOf(
			getWidgetData(rqoFor(OUT_OF_SCOPE_RECORD_ID), contextFor(control)),
		);
		expect(refusal.code).toBe('perm.out_of_scope');

		const served = await getWidgetData(rqoFor(OUT_OF_SCOPE_RECORD_ID), contextFor(superuser));
		expect(served.body as unknown).toEqual(servedBody(OUT_OF_SCOPE_VALUE));
	});

	test('(d) a non-integer / non-address section_id ⇒ request.invalid_source BY NAME (never a perm refusal)', async () => {
		for (const sectionId of ['abc', 1.5, '007', true, { id: 1 }, null, undefined, 2 ** 40]) {
			// The superuser AND the control: the grammar refusal precedes every grant.
			for (const principal of [superuser, control]) {
				const refusal = await refusalOf(getWidgetData(rqoFor(sectionId), contextFor(principal)));
				expect(refusal.code, `section_id ${JSON.stringify(sectionId)} as ${principal.userId}`).toBe(
					'request.invalid_source',
				);
			}
		}
		// Positive control: the counted string form of an address is still served.
		const served = await getWidgetData(rqoFor(String(IN_SCOPE_RECORD_ID)), contextFor(control));
		expect(served.body as unknown).toEqual(servedBody(IN_SCOPE_VALUE));
	});
});
