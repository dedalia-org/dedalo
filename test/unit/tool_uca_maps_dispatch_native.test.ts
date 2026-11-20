/**
 * tool_uca_maps through the real dispatcher, as non-admin users. The declared
 * gates (tool_uca_maps_action_gates) only say what each action asks for; this
 * proves the dispatcher ENFORCES it: no grant, the wrong record, an ungranted
 * component or a read-only level are refused before the handler runs, and each
 * refusal has its passing control, so a gate that refused everything is red too.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { invalidateAllToolCaches } from '../../src/core/tools/cache.ts';
import { dispatchToolRequest } from '../../src/core/tools/dispatch.ts';
import { getActiveToolMetaBySectionId } from '../../src/core/tools/registry.ts';
import { refusalOf } from '../helpers/refusal.ts';
import {
	SB_DENIED_SECTION,
	SB_GRANTED_COMPONENT,
	SB_GRANTED_SECTION,
	scopeBindingSlot,
} from '../helpers/scope_binding_fixture.ts';

const TOOL = 'tool_uca_maps';
/** A test3 component neither profile grants. */
const UNGRANTED_COMPONENT = 'test91';
/** A user with no profile: the tool is not granted to it. */
const NO_GRANT: Principal = { userId: 999_999, isGlobalAdmin: false, isDeveloper: false };

const sb = scopeBindingSlot();
let A: Principal;
let B: Principal;
/** A test3 record in B's project: inside B's scope, outside A's. */
let recordOfB = 0;
/** A test65 record (test65 has no project filter), where B holds read only. */
let readOnlyRecordOfB = 0;

/** Add the tool to a fixture profile's dd1067 grants (the fixture grants a fixed list). */
async function grantTool(profileId: number, registryId: number): Promise<void> {
	await sql.unsafe(
		`UPDATE matrix_profiles
		 SET relation = jsonb_set(relation, '{dd1067}',
			coalesce(relation->'dd1067', '[]'::jsonb) || $2::text::jsonb)
		 WHERE section_tipo = 'dd234' AND section_id = $1`,
		[
			profileId,
			encodeForJsonb([
				{
					id: 99,
					type: 'dd151',
					section_id: registryId,
					section_tipo: 'dd1324',
					from_component_tipo: 'dd1067',
				},
			]),
		],
	);
}

/** Put a record in the default project, the scope B's records ride. */
async function stampDefaultProject(
	table: string,
	sectionTipo: string,
	sectionId: number,
	filterTipo: string,
) {
	await sql.unsafe(
		`UPDATE ${table} SET relation = coalesce(relation, '{}'::jsonb) || $3::text::jsonb
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			sectionTipo,
			sectionId,
			encodeForJsonb({
				[filterTipo]: [
					{
						id: 1,
						type: 'dd675',
						section_id: config.features.defaultProject,
						section_tipo: config.features.filterSectionTipo,
						from_component_tipo: filterTipo,
					},
				],
			}),
		],
	);
}

function clearCaches(): void {
	clearPermissionsCache();
	clearPrincipalCache();
	invalidateAllToolCaches();
}

const dispatch = (principal: Principal, action: string, options: Record<string, unknown>) =>
	dispatchToolRequest(principal, principal.userId, { model: TOOL, action }, options);

/** get_capabilities: record_tipo at read level, readOnly, and touches nothing outside. */
const target = (section_tipo: string, section_id: number, tipo = SB_GRANTED_COMPONENT) => ({
	section_tipo,
	section_id,
	tipo,
});

beforeAll(async () => {
	await sb.install();
	const registry = await getActiveToolMetaBySectionId();
	const ids = [...registry.entries()].filter(([, meta]) => meta.name === TOOL).map(([id]) => id);
	if (ids.length !== 1)
		throw new Error(`${TOOL}: ${ids.length} active registry rows — run 'bun run test:db:setup'`);
	await grantTool(sb.profileA, ids[0] as number);
	await grantTool(sb.profileB, ids[0] as number);
	clearCaches();
	A = await resolvePrincipal(sb.userA);
	B = await resolvePrincipal(sb.userB);
	recordOfB = await createSectionRecord(SB_GRANTED_SECTION, sb.userB);
	await stampDefaultProject('matrix_test', SB_GRANTED_SECTION, recordOfB, 'test101');
	readOnlyRecordOfB = await createSectionRecord(SB_DENIED_SECTION, -1);
});

afterAll(async () => {
	try {
		if (recordOfB > 0) await deleteSectionRecord(SB_GRANTED_SECTION, recordOfB, -1);
		if (readOnlyRecordOfB > 0) await deleteSectionRecord(SB_DENIED_SECTION, readOnlyRecordOfB, -1);
	} finally {
		await sb.release();
		clearCaches();
	}
});

describe('tool_uca_maps — the dispatcher enforces each action’s gate', () => {
	test('control: B reaches the handler on its own record and a granted component', async () => {
		const response = await dispatch(B, 'get_capabilities', target(SB_GRANTED_SECTION, recordOfB));
		expect(response.data).toBeDefined();
	});

	test('a user the tool is not granted to is refused before any action', async () => {
		const error = await refusalOf(
			dispatch(NO_GRANT, 'get_capabilities', target(SB_GRANTED_SECTION, recordOfB)),
		);
		expect(error.code).toBe('tool.not_authorized');
	});

	test('A holds the section but the record is outside its scope', async () => {
		const error = await refusalOf(
			dispatch(A, 'get_capabilities', target(SB_GRANTED_SECTION, recordOfB)),
		);
		expect(error.code).toBe('perm.denied');
	});

	test('B on its own record, but a component its profile does not grant', async () => {
		const error = await refusalOf(
			dispatch(B, 'get_capabilities', target(SB_GRANTED_SECTION, recordOfB, UNGRANTED_COMPONENT)),
		);
		expect(error.code).toBe('perm.denied');
	});

	test('control: read level reaches the handler where B holds read only', async () => {
		const response = await dispatch(
			B,
			'get_capabilities',
			target(SB_DENIED_SECTION, readOnlyRecordOfB),
		);
		expect(response.data).toBeDefined();
	});

	test('stage_external_image needs write: refused there, before it fetches anything', async () => {
		const error = await refusalOf(
			dispatch(B, 'stage_external_image', {
				...target(SB_DENIED_SECTION, readOnlyRecordOfB),
				url: 'https://example.test/never-fetched.png',
			}),
		);
		expect(error.code).toBe('perm.denied');
	});
});
