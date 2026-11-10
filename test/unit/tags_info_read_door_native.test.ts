/**
 * T0-3 — THE READ DOOR of `dd_component_text_area_api:get_tags_info` and its
 * hops (WC-2026-11-10-tags-info-read-door; WC-077 AUTHZ-01 amended).
 *
 * The door: the write door's READ mode (section >= 1 → the text_area's pair
 * grant → the record scope), decided BEFORE the options. The hops, gated inside
 * buildTagsInfo with the same principal: every NOTE record (the ddo pair grants
 * + the note's scope — a refused note is dropped and NAMED in `withheld_notes`,
 * owner OD-2 (a)), the HOST tag-source component of index/reference (its own
 * pair grant; term labels pass "as displayed", OD-3 (a)), the persons
 * inverse search (SCOPED to the caller, silently — in SQL), and each persons
 * owner's SOURCE component (its own pair grant; a refused owner is skipped).
 *
 * Every refusal is a PAIR: the reader is refused / narrowed, and a CONTROL that
 * is identical (non-admin, the SAME project) except for the ONE grant under test
 * is served on the same call — a door that refuses everything cannot pass.
 *
 * Situation: the shared `zztags` scratch ontology (test/helpers/zztags_situation.ts)
 * + test/helpers/tags_info_door_fixture.ts (explicit ids 937300-937399), both
 * swept in afterAll with fail-loud residue checks.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { componentTextAreaApiActions } from '../../src/core/api/handlers/dd_component_text_area_api.ts';
import type { ApiResult } from '../../src/core/api/response.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import type { Session } from '../../src/core/security/session_store.ts';
import { dropSituation, ensureSituation } from '../../src/core/test_data/situations/situation.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	installTagsInfoDoorFixture,
	removeTagsInfoDoorFixture,
	TAGS_HOST_ID,
	TAGS_INDEX_LOCATOR,
	TAGS_NOTE_IN_ID,
	TAGS_NOTE_OUT_ID,
	TAGS_PERSON_OF_IN,
	TAGS_PERSONAS,
	TAGS_RELATED_IN_ID,
	TAGS_RELATED_OUT_ID,
} from '../helpers/tags_info_door_fixture.ts';
import {
	ZZTAGS_NOTE_SECTION,
	ZZTAGS_PERSONS_PORTAL,
	ZZTAGS_SECTION,
	ZZTAGS_SITUATION,
	ZZTAGS_TEXT_AREA,
} from '../helpers/zztags_situation.ts';

const DOOR = 'get_tags_info';
const getTagsInfo = mustGet(componentTextAreaApiActions[DOOR], `${DOOR} handler`);

/** The SUPERUSER (root, -1): the read door's section + pair steps answer it by rule. */
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const persona = (key: keyof typeof TAGS_PERSONAS): Principal => ({
	userId: TAGS_PERSONAS[key].userId,
	isGlobalAdmin: false,
	isDeveloper: false,
});

const contextFor = (principal: Principal): ApiRequestContext => ({
	requestId: 't0-3-tags-info',
	clientIp: '127.0.0.1',
	session: {
		userId: principal.userId,
		username: `scratch_${principal.userId}`,
		isGlobalAdmin: principal.isGlobalAdmin,
		csrfToken: 'x',
		applicationLang: null,
		dataLang: null,
	} as Session,
	csrfCandidate: null,
	principal,
});

const rqoOf = (arType: unknown): Rqo =>
	({
		action: DOOR,
		dd_api: 'dd_component_text_area_api',
		source: {
			tipo: ZZTAGS_TEXT_AREA,
			section_tipo: ZZTAGS_SECTION,
			section_id: TAGS_HOST_ID,
			lang: 'lg-spa',
		},
		options: { ar_type: arType },
	}) as unknown as Rqo;

interface TagsBody {
	ok: boolean;
	data: {
		tags_index?: unknown[];
		tags_notes?: { data: { section_id: unknown } }[];
		tags_persons?: { section_id: unknown }[];
	};
	unknown_types?: string[];
	withheld_notes?: unknown[];
	notices?: { code: string }[];
}

/** Call the door INSIDE a request context, so the read door's notices are observable. */
async function call(principal: Principal, arType: unknown): Promise<ApiResult> {
	const context = contextFor(principal);
	return runWithRequestContext(
		{ principal, session: context.session, requestId: context.requestId, clientIp: '127.0.0.1' },
		() => getTagsInfo(rqoOf(arType), context),
	);
}

async function served(principal: Principal, arType: unknown): Promise<TagsBody> {
	const result = await call(principal, arType);
	expect(result.status).toBe(200);
	const body = result.body as unknown as TagsBody;
	expect(body.ok).toBe(true);
	return body;
}

async function refusalOf(principal: Principal, arType: unknown): Promise<DedaloError> {
	const outcome = await call(principal, arType).then(
		(value) => ({ threw: false as const, value }),
		(error: unknown) => ({ threw: true as const, error }),
	);
	if (!outcome.threw)
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value.body)}`);
	if (!(outcome.error instanceof DedaloError)) throw outcome.error;
	return outcome.error;
}

/** The note the control may read, resolved through the ddo map. */
const NOTE_IN = {
	data: { section_tipo: ZZTAGS_NOTE_SECTION, section_id: TAGS_NOTE_IN_ID },
	title: ['note in scope'],
	body: ['note in scope body'],
	publishable: true,
};
const INDEX_ELEMENT = { data: TAGS_INDEX_LOCATOR, label: 'input text content of one' };

/** The control's exact answer to ['index','note']: the out-of-scope note withheld + named. */
const CONTROL_BODY = {
	tags_index: [INDEX_ELEMENT],
	tags_notes: [NOTE_IN],
};

/**
 * One CONTROL person element: the in-scope related record (937352) owns both
 * persons its zztags9 portal stores (the host + 937392). Neither person record
 * carries a name, so label/full_name are empty and the role is the bare tipo
 * (the scratch node has no term).
 */
const controlPerson = (personId: number) => ({
	type: 'person',
	section_tipo: ZZTAGS_NOTE_SECTION,
	section_id: TAGS_RELATED_IN_ID,
	tag: `[person-a-1--data:{'section_tipo':'${ZZTAGS_SECTION}','section_id':'${personId}','component_tipo':'${ZZTAGS_PERSONS_PORTAL}'}:data]`,
	role: ZZTAGS_PERSONS_PORTAL,
	full_name: '',
	state: 'a',
	tag_id: 1,
	label: '',
	data: {
		section_tipo: ZZTAGS_SECTION,
		section_id: personId,
		component_tipo: ZZTAGS_PERSONS_PORTAL,
	},
});
const CONTROL_PERSONS = [controlPerson(TAGS_HOST_ID), controlPerson(TAGS_PERSON_OF_IN)];

const noteIds = (body: TagsBody) => (body.data.tags_notes ?? []).map((n) => n.data.section_id);
const ownerIds = (body: TagsBody) =>
	[...new Set((body.data.tags_persons ?? []).map((p) => Number(p.section_id)))].sort();

beforeAll(async () => {
	await ensureSituation(ZZTAGS_SITUATION);
	await installTagsInfoDoorFixture();
});

afterAll(async () => {
	await removeTagsInfoDoorFixture();
	expect(await dropSituation(ZZTAGS_SITUATION)).toBe(0);
});

describe(`${DOOR} — the host read door (section → pair → scope)`, () => {
	test('CONTROL is served the exact shape (positive half of every pair)', async () => {
		const body = await served(persona('CONTROL'), ['index', 'note']);
		// Floors: the control really resolved something on each hop.
		expect(body.data.tags_index).toHaveLength(1);
		expect(body.data.tags_notes).toHaveLength(1);
		expect(body.data).toEqual(CONTROL_BODY);
		expect(body.unknown_types).toEqual([]);
		expect(body.withheld_notes).toEqual([TAGS_NOTE_OUT_ID]);
	});

	test('(a) no SECTION grant, record in scope ⇒ perm.denied; control served', async () => {
		const refusal = await refusalOf(persona('NO_SECTION'), ['index', 'note']);
		expect(refusal.code).toBe('perm.denied');
		expect(refusal.spec.status).toBe(403);
		expect((await served(persona('CONTROL'), ['index', 'note'])).data).toEqual(CONTROL_BODY);
	});

	test('(b) section granted, TEXT_AREA grant 0 ⇒ perm.denied; control served', async () => {
		const refusal = await refusalOf(persona('NO_TEXT_AREA'), ['index', 'note']);
		expect(refusal.code).toBe('perm.denied');
		expect((await served(persona('CONTROL'), ['index', 'note'])).data).toEqual(CONTROL_BODY);
	});

	test('(e) an unauthorized caller with a BAD ar_type ⇒ perm.denied, not request.invalid_options', async () => {
		for (const bad of [[], 'index', undefined]) {
			expect((await refusalOf(persona('NO_SECTION'), bad)).code).toBe('perm.denied');
		}
		// The authorized control on the same bad request learns the grammar.
		expect((await refusalOf(persona('CONTROL'), [])).code).toBe('request.invalid_options');
	});
});

describe(`${DOOR} — the NOTE hop (drop + name, OD-2 (a))`, () => {
	test('(c1) note SECTION denied ⇒ every note absent + named in withheld_notes; control has the note', async () => {
		const reader = await served(persona('NO_NOTE_SECTION'), ['note']);
		expect(reader.data.tags_notes).toEqual([]);
		expect(reader.withheld_notes).toEqual([TAGS_NOTE_IN_ID, TAGS_NOTE_OUT_ID]);
		expect(reader.notices?.map((n) => n.code)).toEqual(['perm.out_of_scope']);

		const control = await served(persona('CONTROL'), ['note']);
		expect(control.data.tags_notes).toEqual([NOTE_IN]);
		expect(control.withheld_notes).toEqual([TAGS_NOTE_OUT_ID]);
	});

	test('(c2) one note COMPONENT denied (body) ⇒ note absent + named; control has the note', async () => {
		const reader = await served(persona('NO_NOTE_COMPONENT'), ['note']);
		expect(noteIds(reader)).toEqual([]);
		expect(reader.withheld_notes).toEqual([TAGS_NOTE_IN_ID, TAGS_NOTE_OUT_ID]);
		expect(noteIds(await served(persona('CONTROL'), ['note']))).toEqual([TAGS_NOTE_IN_ID]);
	});

	test('(c3) note RECORD scope: the out-of-project note is withheld for the control, served to a superuser', async () => {
		const control = await served(persona('CONTROL'), ['note']);
		expect(noteIds(control)).toEqual([TAGS_NOTE_IN_ID]);
		const admin = await served(ADMIN, ['note']);
		expect(noteIds(admin)).toEqual([TAGS_NOTE_IN_ID, TAGS_NOTE_OUT_ID]);
		expect(admin.withheld_notes).toEqual([]);
		expect(admin.notices).toBeUndefined();
	});
});

describe(`${DOOR} — the HOST tag-source hop (index/reference)`, () => {
	test('tags_index source component denied ⇒ tags_index absent + notice; control has it', async () => {
		const reader = await served(persona('NO_TAG_SOURCE'), ['index']);
		expect(reader.data.tags_index).toBeUndefined();
		expect(reader.notices?.map((n) => n.code)).toEqual(['perm.out_of_scope']);
		const control = await served(persona('CONTROL'), ['index']);
		expect(control.data.tags_index).toEqual([INDEX_ELEMENT]);
		expect(control.notices).toBeUndefined();
	});
});

describe(`${DOOR} — the PERSONS hop (scoped inverse search + source component grant)`, () => {
	test('(d) an out-of-scope referencing record never feeds tags_persons; a superuser sees both', async () => {
		const reader = await served(persona('CONTROL'), ['person']);
		expect(ownerIds(reader)).toEqual([TAGS_RELATED_IN_ID]);
		const admin = await served(ADMIN, ['person']);
		// Floor: the superuser's feed holds both owners' persons (3 after the host dedup).
		expect((admin.data.tags_persons ?? []).length).toBeGreaterThan(2);
		expect(ownerIds(admin)).toEqual([TAGS_RELATED_IN_ID, TAGS_RELATED_OUT_ID].sort());
	});

	test('(f) persons SOURCE component (zztags9) at 0 ⇒ its entries absent + notice; control served the exact shape', async () => {
		const reader = await served(persona('NO_PERSONS_COMPONENT'), ['person']);
		expect(reader.data.tags_persons).toEqual([]);
		expect(reader.notices?.map((n) => n.code)).toEqual(['perm.out_of_scope']);

		const control = await served(persona('CONTROL'), ['person']);
		expect(control.data.tags_persons).toEqual(CONTROL_PERSONS);
		expect(control.notices).toBeUndefined();
	});
});
