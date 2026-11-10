/**
 * THE AUTHORIZATION-DOOR FIXTURE (closure Step 3 — the write door, SEC-1/2/3,
 * TOOLS-3/4). One situation every Step-3 gate shares, so no gate invents a
 * fifth identity table.
 *
 * WHY NOT ONLY THE TWO EXISTING FIXTURES. `read_door_identity_fixture` mints a
 * READER and a CONTROL that differ on READ grants (test91/test99/test80/test96)
 * and `acl_identity_fixture` an admin/reader pair on test92. The authorization
 * door needs contrasts neither holds:
 *
 *   - the WRITE pair on the MEDIA components (test94 component_av, test26
 *     component_3d, test17 component_text_area) — granted at 2 on the control,
 *     explicitly 0 on the section-only identity;
 *   - a COMPONENT-ONLY identity (components at 2, the section at an explicit 0)
 *     — what separates the section half of the door from the pair half;
 *   - an OUT-OF-SCOPE twin of the control (identical grants, a DIFFERENT
 *     project) — what separates the scope half from both;
 *   - the dd128 USER-MANAGER role (level 2 on `(dd128, dd1725)`) — the
 *     privilege the own-record downgrade exists to neutralise;
 *   - a GLOBAL ADMIN holding `(dd128, dd133)` at 2 — the SEC-05 shape (root's
 *     password is dd128/-1);
 *   - a TOOL-GRANTED twin of the control (dd1067 → tool_assistant) — the
 *     granted/ungranted contrast of the agent door.
 *
 * It therefore EXTENDS the family: the read-door fixture's READER / CONTROL /
 * MEDIA-ONLY stay the read-side identities (install both), this one adds the
 * write-side ones. Same conventions, same sweep law.
 *
 * WHAT IT MINTS (band 944000-944099; users/profiles/projects are ordinary
 * dd128/dd234/dd153 records, no ontology node is written):
 *
 *   944021 dd153  PROJECT_P — the project every in-scope record carries
 *   944022 dd153  PROJECT_Q — the out-of-scope identity's only project
 *
 *   user/profile  identity         dd244   project  grants (dd774)
 *   944001/944011 CONTROL          No      P        test3=2 + MEDIA_COMPONENTS=2 + test52/test101/test162/zzauthz1/test99=2
 *                                                   + test126=2 (test3's button_new: CONTROL MAY CREATE — the
 *                                                   T0-2 New-button predicate asks it at the user create doors;
 *                                                   core create is SECTION level and does not)
 *   944002/944012 SECTION_ONLY     No      P        test3=2, MEDIA_COMPONENTS=0 (explicit), test101=1,
 *                                                   test126=2 (may create: its refusals are the components')
 *   944003/944013 COMPONENT_ONLY   No      P        test3=0 (explicit), MEDIA_COMPONENTS=2, test101=1
 *   944004/944014 OUT_OF_SCOPE     No      Q        = CONTROL
 *   944005/944015 USER_MANAGER     No      P        dd128=2, dd128.dd1725=2, dd128.dd132=2
 *   944006/944016 DD128_ADMIN      YES     P        dd128=2, dd128.dd133=2 + CONTROL's test3 grants
 *   944007/944017 TOOL_GRANTED     No      P        = CONTROL, plus dd1067 → tool_assistant,
 *                                                   tool_identify, tool_rag
 *   944008/944018 LEVEL_1          No      P        test3=1 + MEDIA_COMPONENTS=1 + test101=1 (read, never write)
 *   944009/944019 TEXT_ONLY        No      P        test3=2, test17=2, AUTHZ_SUBTITLE_TEXT_AREA=2, test94=0,
 *                                                   test126=2 (may create)
 *                                                   (the transcript is writable, its AV is not)
 *   944010/944020 TRANSCRIBER      No      P        test3=2, test17=2, AUTHZ_SUBTITLE_TEXT_AREA=2, test94=1
 *                                                   (the typical transcriber: hears the AV, writes the transcript)
 *   944023/944033 READ_COMPONENT   No      P        test3=2, MEDIA_COMPONENTS=1, AUTHZ_SUBTITLE_TEXT_AREA=1, test101=1
 *                                                   (the section WRITABLE, every media component READ-only — the
 *                                                   only identity that reaches a write door's PAIR half at 1: the
 *                                                   section floor passes it, so only the pair can refuse it)
 *   944024/944034 READ_SECTION     No      P        test3=1, MEDIA_COMPONENTS=2, test101=1
 *                                                   (the mirror of READ_COMPONENT: the section READ-only, every media
 *                                                   component WRITABLE — the pair passes a write, so only the
 *                                                   section floor at 2 can refuse it: the media WRITE doors' floor)
 *
 *   944025/944035 TREE_EDITOR      No      P        test3=2, test201=2 (children), test71=2 (parent),
 *                                                   test22=2 (sibling order), test101=1 — writes a hierarchy;
 *                                                   with OUT_OF_SCOPE's twin absent, scope is its only refusal
 *
 *   944026/944036 PORTAL_EDITOR    No      P        test3=2, test80=2 (portal → test3), test126=2 (test3's
 *                                                   button_new), test101=1; test6100=2, test6274=1 (its
 *                                                   button_new, READ), test6216=2, test6254=1; test38=2 (no
 *                                                   button_new); test65=2, test13=2 (button_new — a fully
 *                                                   create-granted section OUTSIDE test80's targets) +
 *                                                   test156/test73/test19=2, test151=1 (test65's children,
 *                                                   parent, order, filter); dd128/dd234: nothing. The T0-2
 *                                                   create gate's persona (add_new_element_create_gate_native)
 *   944027/944037 CHILD_EDITOR     No      P        = PORTAL_EDITOR's test65 grants with test13 (the
 *                                                   button_new) at an EXPLICIT 0 — writes test65's children,
 *                                                   may not create there
 *
 *   944028/944038 FEATURE_EDITOR   No      P        rsc326/rsc832/rsc377/rsc425/rsc1379=2 (the SECTION only —
 *                                                   the feature-owned sections ship no button_new: notes, TM
 *                                                   notes, index notes, references, dataframe Annotation
 *                                                   frames); test3=2, test80=2, test101=1, test126 at an
 *                                                   EXPLICIT 0 (writes test3's portal, may NOT press its
 *                                                   "New"); test6100=2 with test6274 at an explicit 0. The
 *                                                   section-level create doors' persona (T0-2 D4/D3 revised:
 *                                                   core create, tool-driven add_new_element)
 *
 *   (User ids skip 944021/944022 — the projects — so a profile id, N + 10,
 *   never lands on another record of the band.)
 *
 *   SECTION_ONLY's zeros are EXPLICIT on every component a NO_COMPONENT cell
 *   is probed on (the media components, test52, zzauthz1) — a present-but-zero
 *   row, never an absent one; TOOL_GRANTED authorizes tool_assistant (the agent
 *   door), tool_identify (the vision spend, TOOLS-4's grant half) AND tool_rag
 *   (the generative RAG answer, TOOLS-4's budget half).
 *
 * RECORDS are ENGINE-BUILT (never raw INSERTs, never a phantom id):
 * `createDoorRecord` runs `createSectionRecord` with the project locator as its
 * `filterData` (the ontology-declared birth state, exactly as a curator's
 * record is born) and then `saveComponentData` for each value. The ids come
 * from the section counter; `dropDoorRecords` sweeps what THIS process created
 * (and its TM rows) and throws on a 0-row delete.
 *
 * THE GRANTS ARE VERIFIED, NOT TRUSTED: every consumer's first test asserts the
 * contrast back through the real resolver (`assertAuthzDoorContrast`), so a
 * fixture that claims a level it does not confer reddens there, not as a
 * vacuous pass somewhere downstream.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { toolGrantLocator } from './tool_grant_fixture.ts';

// --- identities -------------------------------------------------------------

export const AUTHZ_PROJECT_P = 944021;
export const AUTHZ_PROJECT_Q = 944022;

export const AUTHZ_CONTROL_USER_ID = 944001;
export const AUTHZ_SECTION_ONLY_USER_ID = 944002;
export const AUTHZ_COMPONENT_ONLY_USER_ID = 944003;
export const AUTHZ_OUT_OF_SCOPE_USER_ID = 944004;
export const AUTHZ_USER_MANAGER_USER_ID = 944005;
export const AUTHZ_DD128_ADMIN_USER_ID = 944006;
export const AUTHZ_TOOL_GRANTED_USER_ID = 944007;
export const AUTHZ_LEVEL_1_USER_ID = 944008;
export const AUTHZ_TEXT_ONLY_USER_ID = 944009;
export const AUTHZ_TRANSCRIBER_USER_ID = 944010;
export const AUTHZ_READ_COMPONENT_USER_ID = 944023;
export const AUTHZ_READ_SECTION_USER_ID = 944024;
export const AUTHZ_TREE_EDITOR_USER_ID = 944025;
export const AUTHZ_PORTAL_EDITOR_USER_ID = 944026;
export const AUTHZ_CHILD_EDITOR_USER_ID = 944027;
export const AUTHZ_FEATURE_EDITOR_USER_ID = 944028;
/**
 * The feature-owned sections WITHOUT a button_new (T0-2 regression hunt,
 * 2026-11-10): text-area notes, Time Machine notes, index notes, references,
 * dataframe Annotation frames. Seed-shipped `rsc` (core-installed on every
 * install), spelled through {@link seedTipo} as the generic-TLD census asks.
 */
const seedTipo = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;
export const AUTHZ_FEATURE_SECTIONS = [
	seedTipo('rsc', 326),
	seedTipo('rsc', 832),
	seedTipo('rsc', 377),
	seedTipo('rsc', 425),
	seedTipo('rsc', 1379),
] as const;
/** test3's component_relation_children / its paired component_relation_parent / the order number. */
export const AUTHZ_CHILDREN = 'test201';
export const AUTHZ_PARENT = 'test71';
export const AUTHZ_ORDER = 'test22';
/** test3's component_portal (targets test3 only). */
export const AUTHZ_PORTAL = 'test80';
/** test3's button_new — the create grant on test3. */
export const AUTHZ_BUTTON_NEW = 'test126';
/** A section whose button_new (test6274) the PORTAL_EDITOR holds at READ only. */
export const AUTHZ_READ_BUTTON_SECTION = 'test6100';
export const AUTHZ_READ_BUTTON_NEW = 'test6274';
/** test6100's component_input_text (a find_or_create match field) / component_filter. */
export const AUTHZ_READ_BUTTON_TEXT = 'test6216';
export const AUTHZ_READ_BUTTON_FILTER = 'test6254';
/** A section with NO button_new at all. */
export const AUTHZ_NO_BUTTON_SECTION = 'test38';
/** A fully create-granted section (button_new test13) OUTSIDE test80's targets. */
export const AUTHZ_OFF_TARGET_SECTION = 'test65';
export const AUTHZ_OFF_TARGET_BUTTON_NEW = 'test13';
/** test65's component_relation_children / parent / order / filter (a project-filtered hierarchy). */
export const AUTHZ_OFF_TARGET_CHILDREN = 'test156';
export const AUTHZ_OFF_TARGET_PARENT = 'test73';
export const AUTHZ_OFF_TARGET_ORDER = 'test19';
export const AUTHZ_OFF_TARGET_FILTER = 'test151';

/** The profile of user N is N + 10 (944001 → 944011). */
const profileOf = (userId: number): number => userId + 10;
/** The dd234 profile the fixture assigns to identity `userId` (its dd1725 value). */
export function authzProfileId(userId: number): number {
	return profileOf(userId);
}
/** The USER_MANAGER's own profile (dd234) — the value its dd1725 already holds. */
export const AUTHZ_USER_MANAGER_PROFILE_ID = profileOf(AUTHZ_USER_MANAGER_USER_ID);

/** The playground section every media/tool door is probed on. */
export const AUTHZ_SECTION = 'test3';
/** test3's component_av. */
export const AUTHZ_AV = 'test94';
/** test3's component_3d. */
export const AUTHZ_3D = 'test26';
/** test3's component_text_area (the transcription WRITE target). */
export const AUTHZ_TEXT_AREA = 'test17';
/** test3's component_input_text. */
export const AUTHZ_TEXT = 'test52';
/** test3's component_filter (the projects membership). */
export const AUTHZ_FILTER = 'test101';
/**
 * test3's component_image — granted to the control so a MODEL probe (an image
 * tipo sent to a 3D/AV door) passes the authorization and reaches the model
 * gate it is about.
 */
export const AUTHZ_IMAGE = 'test99';
/** A second component_input_text of test3 (the root-step oracle's hidden leaf). */
export const AUTHZ_TEXT_2 = 'test162';

/**
 * A scratch component_text_area RELATED to test94 (the AV) — the playground has
 * no text_area→av pairing, so the gate that needs one (tool_transcription's
 * build_subtitles_file AV half) materializes this node under test3 as a `zz*`
 * situation of its own. The fixture only GRANTS it (a grant on an absent tipo
 * is inert).
 */
export const AUTHZ_SUBTITLE_TEXT_AREA = 'zzauthz1';

/**
 * The stub agent MODEL both agent-door gates (agent_access_native,
 * authz_door_matrix_native) configure — a model id in `DEDALO_AGENT_MODELS`,
 * not a tipo. It is spelled ONCE, here: the zz-literal census
 * (scratch_tld_uniqueness_tripwire) reads any `'zz…` literal as a TLD, and two
 * gates spelling it would be a shared TLD by that rule.
 */
export const AUTHZ_STUB_MODEL_ID = 'zzstub';

/** `DEDALO_AGENT_MODELS` naming {@link AUTHZ_STUB_MODEL_ID} on a local stand-in provider. */
export function authzStubAgentModels(providerPort: number | undefined): string {
	if (providerPort === undefined) {
		throw new Error('authzStubAgentModels: the stand-in provider has no port (not listening?)');
	}
	return JSON.stringify([
		{
			id: AUTHZ_STUB_MODEL_ID,
			label: 'zzauthz stub',
			provider: 'openai_compatible',
			model: `${AUTHZ_STUB_MODEL_ID}-native`,
			endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
			egress: 'local',
		},
	]);
}

/** The components the WRITE door is about — granted 2 / explicitly 0. */
export const AUTHZ_MEDIA_COMPONENTS = [AUTHZ_AV, AUTHZ_3D, AUTHZ_TEXT_AREA] as const;

/** The tool the TOOL_GRANTED twin's profile authorizes (the agent door). */
export const AUTHZ_GRANTED_TOOL = 'tool_assistant';
/** The second tool it authorizes: the vision spend's grant (TOOLS-4). */
export const AUTHZ_GRANTED_VISION_TOOL = 'tool_identify';
/** The generative-RAG grant (TOOLS-4's budget half: `dd_rag_api` `ask` asks it). */
export const AUTHZ_GRANTED_RAG_TOOL = 'tool_rag';

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';
const YES = 1;
const NO = 2;

const BAND_LOW = 944000;
const BAND_HIGH = 944099;

interface IdentitySpec {
	userId: number;
	name: string;
	admin: boolean;
	project: number;
	grants: [string, string, number][];
	tools?: readonly string[];
}

const CONTROL_GRANTS: [string, string, number][] = [
	[AUTHZ_SECTION, AUTHZ_SECTION, 2],
	...AUTHZ_MEDIA_COMPONENTS.map((tipo): [string, string, number] => [AUTHZ_SECTION, tipo, 2]),
	[AUTHZ_SECTION, AUTHZ_TEXT, 2],
	[AUTHZ_SECTION, AUTHZ_FILTER, 2],
	[AUTHZ_SECTION, AUTHZ_TEXT_2, 2],
	[AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA, 2],
	[AUTHZ_SECTION, AUTHZ_IMAGE, 2],
	// test3's button_new: the CONTROL (and every identity "= CONTROL") MAY CREATE
	// in test3 — the T0-2 New-button predicate (write_door.ts authorizeRecordCreate)
	// asks it at the portal "+", duplicate, add_child and the MCP create doors.
	// Core create is SECTION level (authorizeSectionCreate, D4 REVISED): not asked.
	[AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2],
];

/** test65's tree (children, parent link, order) writable, its filter readable. */
const OFF_TARGET_TREE_GRANTS: [string, string, number][] = [
	[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_CHILDREN, 2],
	[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_PARENT, 2],
	[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_ORDER, 2],
	[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_FILTER, 1],
];

const IDENTITIES: readonly IdentitySpec[] = [
	{
		userId: AUTHZ_CONTROL_USER_ID,
		name: 'zzauthz_control',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: CONTROL_GRANTS,
	},
	{
		userId: AUTHZ_SECTION_ONLY_USER_ID,
		name: 'zzauthz_section_only',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 2],
			// EXPLICIT zeros — a present-but-zero row, never an absent one — on
			// every component a NO_COMPONENT cell is probed on.
			...AUTHZ_MEDIA_COMPONENTS.map((tipo): [string, string, number] => [AUTHZ_SECTION, tipo, 0]),
			[AUTHZ_SECTION, AUTHZ_TEXT, 0],
			[AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA, 0],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
			// May create in test3 (as on HEAD, when the section level was a create's
			// whole authorization): a NO_COMPONENT cell on a create door (MCP
			// find_or_create) must be refused ON its component, not on the button.
			[AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2],
		],
	},
	{
		userId: AUTHZ_COMPONENT_ONLY_USER_ID,
		name: 'zzauthz_component_only',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 0],
			...AUTHZ_MEDIA_COMPONENTS.map((tipo): [string, string, number] => [AUTHZ_SECTION, tipo, 2]),
			[AUTHZ_SECTION, AUTHZ_TEXT, 2],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
		],
	},
	{
		userId: AUTHZ_OUT_OF_SCOPE_USER_ID,
		name: 'zzauthz_out_of_scope',
		admin: false,
		project: AUTHZ_PROJECT_Q,
		grants: CONTROL_GRANTS,
	},
	{
		userId: AUTHZ_USER_MANAGER_USER_ID,
		name: 'zzauthz_user_manager',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[USERS_SECTION, USERS_SECTION, 2],
			[USERS_SECTION, 'dd1725', 2],
			[USERS_SECTION, 'dd132', 2],
		],
	},
	{
		userId: AUTHZ_DD128_ADMIN_USER_ID,
		name: 'zzauthz_dd128_admin',
		admin: true,
		project: AUTHZ_PROJECT_P,
		grants: [[USERS_SECTION, USERS_SECTION, 2], [USERS_SECTION, 'dd133', 2], ...CONTROL_GRANTS],
	},
	{
		userId: AUTHZ_LEVEL_1_USER_ID,
		name: 'zzauthz_level_1',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 1],
			...AUTHZ_MEDIA_COMPONENTS.map((tipo): [string, string, number] => [AUTHZ_SECTION, tipo, 1]),
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
		],
	},
	{
		userId: AUTHZ_TEXT_ONLY_USER_ID,
		name: 'zzauthz_text_only',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 2],
			[AUTHZ_SECTION, AUTHZ_TEXT_AREA, 2],
			[AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA, 2],
			[AUTHZ_SECTION, AUTHZ_AV, 0],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
			// May create in test3: its refusal on a create door (MCP find_or_create's
			// SET field) must be the AV's, not the button's.
			[AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2],
		],
	},
	{
		userId: AUTHZ_TRANSCRIBER_USER_ID,
		name: 'zzauthz_transcriber',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 2],
			[AUTHZ_SECTION, AUTHZ_TEXT_AREA, 2],
			[AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA, 2],
			[AUTHZ_SECTION, AUTHZ_AV, 1],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
		],
	},
	{
		// The section at WRITE (2) and every media component at READ (1): past a
		// write door's section floor, so its PAIR half is the only thing that can
		// refuse it — the level-2 pair on the AV / 3D / transcript, isolated.
		userId: AUTHZ_READ_COMPONENT_USER_ID,
		name: 'zzauthz_read_component',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 2],
			...AUTHZ_MEDIA_COMPONENTS.map((tipo): [string, string, number] => [AUTHZ_SECTION, tipo, 1]),
			[AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA, 1],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
		],
	},
	{
		// The mirror: the section at READ (1), every media component at WRITE (2).
		// The level-2 pair passes a write, so only a write door's SECTION floor
		// (2 on the media writes — HEAD's `getPermissions(s, s) >= 2`) refuses it.
		userId: AUTHZ_READ_SECTION_USER_ID,
		name: 'zzauthz_read_section',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 1],
			...AUTHZ_MEDIA_COMPONENTS.map((tipo): [string, string, number] => [AUTHZ_SECTION, tipo, 2]),
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
		],
	},
	{
		// Writes a hierarchy: the children field, the parent link it writes
		// through, and the sibling order paired to that link.
		userId: AUTHZ_TREE_EDITOR_USER_ID,
		name: 'zzauthz_tree_editor',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 2],
			[AUTHZ_SECTION, AUTHZ_CHILDREN, 2],
			[AUTHZ_SECTION, AUTHZ_PARENT, 2],
			[AUTHZ_SECTION, AUTHZ_ORDER, 2],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
		],
	},
	{
		// The create gate's persona (T0-2): writes test3's portal and children,
		// may create in test3 (button_new at 2) and test65 (outside the portal's
		// targets); holds test6100 at 2 but its button_new at READ (1); test38 at
		// 2 with no button_new to hold; nothing on dd128/dd234.
		userId: AUTHZ_PORTAL_EDITOR_USER_ID,
		name: 'zzauthz_portal_editor',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_SECTION, AUTHZ_SECTION, 2],
			[AUTHZ_SECTION, AUTHZ_PORTAL, 2],
			[AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
			[AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_SECTION, 2],
			[AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_NEW, 1],
			[AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_TEXT, 2],
			[AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_FILTER, 1],
			[AUTHZ_NO_BUTTON_SECTION, AUTHZ_NO_BUTTON_SECTION, 2],
			[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_SECTION, 2],
			[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_BUTTON_NEW, 2],
			...OFF_TARGET_TREE_GRANTS,
		],
	},
	{
		// The children door's refusal: test65's tree writable, its button_new at an
		// EXPLICIT 0 — the create grant is the only thing it lacks.
		userId: AUTHZ_CHILD_EDITOR_USER_ID,
		name: 'zzauthz_child_editor',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_SECTION, 2],
			[AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_BUTTON_NEW, 0],
			...OFF_TARGET_TREE_GRANTS,
		],
	},
	{
		// The SECTION-level create doors' persona (T0-2, D4/D3 revised 2026-11-10):
		// write on every feature section (none ships a button_new) and on test3 +
		// its portal, with test3's button_new and test6100's at an EXPLICIT 0 —
		// core create and a tool-driven add_new_element must admit it, every
		// New-button door must refuse it.
		userId: AUTHZ_FEATURE_EDITOR_USER_ID,
		name: 'zzauthz_feature_editor',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: [
			...AUTHZ_FEATURE_SECTIONS.map((tipo): [string, string, number] => [tipo, tipo, 2]),
			[AUTHZ_SECTION, AUTHZ_SECTION, 2],
			[AUTHZ_SECTION, AUTHZ_PORTAL, 2],
			[AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 0],
			[AUTHZ_SECTION, AUTHZ_FILTER, 1],
			[AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_SECTION, 2],
			[AUTHZ_READ_BUTTON_SECTION, AUTHZ_READ_BUTTON_NEW, 0],
		],
	},
	{
		userId: AUTHZ_TOOL_GRANTED_USER_ID,
		name: 'zzauthz_tool_granted',
		admin: false,
		project: AUTHZ_PROJECT_P,
		grants: CONTROL_GRANTS,
		tools: [AUTHZ_GRANTED_TOOL, AUTHZ_GRANTED_VISION_TOOL, AUTHZ_GRANTED_RAG_TOOL],
	},
];

const OWNED: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: AUTHZ_PROJECT_P },
	{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: AUTHZ_PROJECT_Q },
	...IDENTITIES.flatMap((identity) => [
		{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: identity.userId },
		{
			table: 'matrix_profiles',
			sectionTipo: PROFILES_SECTION,
			sectionId: profileOf(identity.userId),
		},
	]),
];

function locator(componentTipo: string, sectionTipo: string, sectionId: number, type = 'dd151') {
	return {
		id: 1,
		type,
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

/** The project locator a record carries in test3's component_filter. */
export function authzProjectLocator(projectId: number = AUTHZ_PROJECT_P) {
	return locator(AUTHZ_FILTER, PROJECTS_SECTION, projectId, 'dd675');
}

function assertBand(): void {
	for (const record of OWNED) {
		if (
			!Number.isInteger(record.sectionId) ||
			record.sectionId < BAND_LOW ||
			record.sectionId > BAND_HIGH
		) {
			throw new Error(
				`authz_door_fixture: ${record.table}/${record.sectionTipo} id ${record.sectionId} is outside the band ${BAND_LOW}-${BAND_HIGH}`,
			);
		}
	}
}

async function insertIdentityRow(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	let index = 3;
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${index}::text::jsonb`);
		params.push(encodeForJsonb(value));
		index++;
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

export function clearAuthzDoorCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
	clearUserFilterRecordsCache();
}

async function purgeIdentities(strict: boolean): Promise<void> {
	assertBand();
	const missing: string[] = [];
	for (const record of OWNED) {
		const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (strict && missing.length > 0) {
		throw new Error(`authz_door_fixture sweep removed 0 rows for: ${missing.join(', ')}`);
	}
}

/** Mint the identities. Idempotent (a crashed run's rows are swept first). */
export async function installAuthzDoorFixture(): Promise<void> {
	await assertTestDatabase('installAuthzDoorFixture');
	assertBand();
	await purgeIdentities(false);

	for (const projectId of [AUTHZ_PROJECT_P, AUTHZ_PROJECT_Q]) {
		await insertIdentityRow('matrix_projects', PROJECTS_SECTION, projectId, {
			string: { dd156: [{ id: 1, lang: 'lg-eng', value: `zzauthz project ${projectId}` }] },
		});
	}
	for (const identity of IDENTITIES) {
		const toolLocators: Awaited<ReturnType<typeof toolGrantLocator>>[] = [];
		for (const [index, toolName] of (identity.tools ?? []).entries()) {
			toolLocators.push(await toolGrantLocator(toolName, index + 1));
		}
		await insertIdentityRow('matrix_profiles', PROFILES_SECTION, profileOf(identity.userId), {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `${identity.name} profile` }] },
			...(toolLocators.length > 0 ? { relation: { dd1067: toolLocators } } : {}),
			misc: {
				dd774: identity.grants.map(([sectionTipo, tipo, value], index) => ({
					id: index + 1,
					tipo,
					section_tipo: sectionTipo,
					value,
				})),
			},
		});
		await insertIdentityRow('matrix_users', USERS_SECTION, identity.userId, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: identity.name }] },
			relation: {
				dd131: [locator('dd131', YES_NO_SECTION, YES)],
				dd244: [locator('dd244', YES_NO_SECTION, identity.admin ? YES : NO)],
				dd515: [locator('dd515', YES_NO_SECTION, NO)],
				dd1725: [locator('dd1725', PROFILES_SECTION, profileOf(identity.userId))],
				dd170: [locator('dd170', PROJECTS_SECTION, identity.project)],
			},
		});
	}
	clearAuthzDoorCaches();
}

export async function removeAuthzDoorFixture(): Promise<void> {
	await assertTestDatabase('removeAuthzDoorFixture');
	await dropDoorRecords();
	await purgeIdentities(true);
	clearAuthzDoorCaches();
}

// --- engine-built records ---------------------------------------------------

/** Every record THIS process created through {@link createDoorRecord}. */
const createdRecords: { sectionTipo: string; sectionId: number }[] = [];

/** One component value to save on a new record: set_data of `value` on `tipo`. */
export interface DoorValue {
	tipo: string;
	lang: string;
	value: unknown[];
}

/**
 * Create a record THROUGH THE ENGINE: `createSectionRecord` (as root, with the
 * project locator as its ontology birth filter) then `saveComponentData` per
 * value. Returns the counter-allocated id.
 */
export async function createDoorRecord(
	sectionTipo: string,
	projectId: number,
	values: readonly DoorValue[] = [],
	filterComponent: string = AUTHZ_FILTER,
): Promise<number> {
	await assertTestDatabase('createDoorRecord');
	const sectionId = await createSectionRecord(sectionTipo, -1, new Date(), undefined, {
		filterData: [locator(filterComponent, PROJECTS_SECTION, projectId, 'dd675')],
	});
	createdRecords.push({ sectionTipo, sectionId });
	// test3 is the unit-test sentinel record_defaults EXCLUDES from the filter
	// birth default (FILTER_EXCLUDED_SECTIONS), so the project membership is
	// SAVED through the engine like any other value — never assumed.
	const membership: DoorValue = {
		tipo: filterComponent,
		lang: 'lg-nolan',
		value: [locator(filterComponent, PROJECTS_SECTION, projectId, 'dd675')],
	};
	for (const value of [membership, ...values]) {
		const saved = await saveComponentData({
			componentTipo: value.tipo,
			sectionTipo,
			sectionId,
			lang: value.lang,
			changedData: [{ action: 'set_data', key: null, value: value.value } as never],
			userId: -1,
		});
		if (!saved.ok) {
			throw new Error(
				`authz_door_fixture: saving ${sectionTipo}/${sectionId} ${value.tipo} failed: ${JSON.stringify(saved)}`,
			);
		}
	}
	return sectionId;
}

/** Sweep every record this process created (and its TM rows); throws on a 0-row delete. */
export async function dropDoorRecords(): Promise<void> {
	await assertTestDatabase('dropDoorRecords');
	const missing: string[] = [];
	while (createdRecords.length > 0) {
		const record = createdRecords.pop() as { sectionTipo: string; sectionId: number };
		const table = await getMatrixTableFromTipo(record.sectionTipo);
		if (table === null) throw new Error(`authz_door_fixture: no table for ${record.sectionTipo}`);
		const removed = await deleteMatrixRecord(table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (missing.length > 0) {
		throw new Error(`authz_door_fixture: record sweep removed 0 rows for ${missing.join(', ')}`);
	}
}

// --- the contrast, asserted through the real resolver -----------------------

export interface AuthzIdentities {
	control: Principal;
	sectionOnly: Principal;
	componentOnly: Principal;
	outOfScope: Principal;
	userManager: Principal;
	dd128Admin: Principal;
	toolGranted: Principal;
	level1: Principal;
	textOnly: Principal;
	transcriber: Principal;
	readComponent: Principal;
	readSection: Principal;
	treeEditor: Principal;
	portalEditor: Principal;
	childEditor: Principal;
	featureEditor: Principal;
}

export async function resolveAuthzIdentities(): Promise<AuthzIdentities> {
	return {
		control: await resolvePrincipal(AUTHZ_CONTROL_USER_ID),
		sectionOnly: await resolvePrincipal(AUTHZ_SECTION_ONLY_USER_ID),
		componentOnly: await resolvePrincipal(AUTHZ_COMPONENT_ONLY_USER_ID),
		outOfScope: await resolvePrincipal(AUTHZ_OUT_OF_SCOPE_USER_ID),
		userManager: await resolvePrincipal(AUTHZ_USER_MANAGER_USER_ID),
		dd128Admin: await resolvePrincipal(AUTHZ_DD128_ADMIN_USER_ID),
		toolGranted: await resolvePrincipal(AUTHZ_TOOL_GRANTED_USER_ID),
		level1: await resolvePrincipal(AUTHZ_LEVEL_1_USER_ID),
		textOnly: await resolvePrincipal(AUTHZ_TEXT_ONLY_USER_ID),
		transcriber: await resolvePrincipal(AUTHZ_TRANSCRIBER_USER_ID),
		readComponent: await resolvePrincipal(AUTHZ_READ_COMPONENT_USER_ID),
		readSection: await resolvePrincipal(AUTHZ_READ_SECTION_USER_ID),
		treeEditor: await resolvePrincipal(AUTHZ_TREE_EDITOR_USER_ID),
		portalEditor: await resolvePrincipal(AUTHZ_PORTAL_EDITOR_USER_ID),
		childEditor: await resolvePrincipal(AUTHZ_CHILD_EDITOR_USER_ID),
		featureEditor: await resolvePrincipal(AUTHZ_FEATURE_EDITOR_USER_ID),
	};
}

/**
 * THROWS unless every identity confers exactly what its row above claims — the
 * guard that keeps every consumer's pairs from degrading to zero-versus-zero.
 */
export async function assertAuthzDoorContrast(ids: AuthzIdentities): Promise<void> {
	const problems: string[] = [];
	const expectLevel = async (label: string, p: Principal, s: string, t: string, want: number) => {
		const got = await getPermissions(p, s, t);
		if (got !== want) problems.push(`${label} (${s},${t}) = ${got}, expected ${want}`);
	};
	for (const [label, p] of [
		['control', ids.control],
		['outOfScope', ids.outOfScope],
		['toolGranted', ids.toolGranted],
	] as const) {
		if (p.isGlobalAdmin) problems.push(`${label} is a global admin`);
		await expectLevel(label, p, AUTHZ_SECTION, AUTHZ_SECTION, 2);
		for (const tipo of AUTHZ_MEDIA_COMPONENTS) await expectLevel(label, p, AUTHZ_SECTION, tipo, 2);
		// May create in test3 (T0-2 New-button predicate: test126 is its button_new).
		await expectLevel(label, p, AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2);
	}
	await expectLevel('sectionOnly', ids.sectionOnly, AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2);
	await expectLevel('level1', ids.level1, AUTHZ_SECTION, AUTHZ_SECTION, 1);
	for (const tipo of AUTHZ_MEDIA_COMPONENTS)
		await expectLevel('level1', ids.level1, AUTHZ_SECTION, tipo, 1);
	await expectLevel('textOnly', ids.textOnly, AUTHZ_SECTION, AUTHZ_TEXT_AREA, 2);
	await expectLevel('textOnly', ids.textOnly, AUTHZ_SECTION, AUTHZ_AV, 0);
	await expectLevel('textOnly', ids.textOnly, AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2);
	await expectLevel('transcriber', ids.transcriber, AUTHZ_SECTION, AUTHZ_TEXT_AREA, 2);
	await expectLevel('transcriber', ids.transcriber, AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA, 2);
	await expectLevel('transcriber', ids.transcriber, AUTHZ_SECTION, AUTHZ_AV, 1);
	await expectLevel('readComponent', ids.readComponent, AUTHZ_SECTION, AUTHZ_SECTION, 2);
	for (const tipo of [...AUTHZ_MEDIA_COMPONENTS, AUTHZ_SUBTITLE_TEXT_AREA]) {
		await expectLevel('readComponent', ids.readComponent, AUTHZ_SECTION, tipo, 1);
	}
	await expectLevel('readSection', ids.readSection, AUTHZ_SECTION, AUTHZ_SECTION, 1);
	for (const tipo of AUTHZ_MEDIA_COMPONENTS) {
		await expectLevel('readSection', ids.readSection, AUTHZ_SECTION, tipo, 2);
	}
	await expectLevel('sectionOnly', ids.sectionOnly, AUTHZ_SECTION, AUTHZ_SECTION, 2);
	for (const tipo of AUTHZ_MEDIA_COMPONENTS) {
		await expectLevel('sectionOnly', ids.sectionOnly, AUTHZ_SECTION, tipo, 0);
		await expectLevel('componentOnly', ids.componentOnly, AUTHZ_SECTION, tipo, 2);
	}
	await expectLevel('componentOnly', ids.componentOnly, AUTHZ_SECTION, AUTHZ_SECTION, 0);
	// The text leaf the save / set_field / save_component cells are probed on:
	// NO_COMPONENT's 0 is an explicit row, NO_SECTION holds it at 2.
	await expectLevel('sectionOnly', ids.sectionOnly, AUTHZ_SECTION, AUTHZ_TEXT, 0);
	await expectLevel('componentOnly', ids.componentOnly, AUTHZ_SECTION, AUTHZ_TEXT, 2);
	await expectLevel('sectionOnly', ids.sectionOnly, AUTHZ_SECTION, AUTHZ_SUBTITLE_TEXT_AREA, 0);
	await expectLevel('userManager', ids.userManager, USERS_SECTION, 'dd1725', 2);
	await expectLevel('sectionOnly', ids.sectionOnly, USERS_SECTION, 'dd522', 0);
	if (!ids.dd128Admin.isGlobalAdmin) problems.push('dd128Admin is not a global admin');
	await expectLevel('dd128Admin', ids.dd128Admin, USERS_SECTION, 'dd133', 2);
	if (ids.treeEditor.isGlobalAdmin) problems.push('treeEditor is a global admin');
	for (const tipo of [AUTHZ_CHILDREN, AUTHZ_PARENT, AUTHZ_ORDER]) {
		await expectLevel('treeEditor', ids.treeEditor, AUTHZ_SECTION, tipo, 2);
	}
	// The contrast the children write-through's permission leg needs.
	await expectLevel('sectionOnly', ids.sectionOnly, AUTHZ_SECTION, AUTHZ_PARENT, 0);
	// The create gate's contrast: test3's button_new held by PORTAL_EDITOR, not
	// by TREE_EDITOR; test6100 writable with its button_new at READ.
	if (ids.portalEditor.isGlobalAdmin) problems.push('portalEditor is a global admin');
	const pe = ids.portalEditor;
	await expectLevel('portalEditor', pe, AUTHZ_SECTION, AUTHZ_SECTION, 2);
	await expectLevel('portalEditor', pe, AUTHZ_SECTION, AUTHZ_PORTAL, 2);
	await expectLevel('portalEditor', pe, AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 2);
	await expectLevel('treeEditor', ids.treeEditor, AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 0);
	const rb = AUTHZ_READ_BUTTON_SECTION;
	await expectLevel('portalEditor', pe, rb, rb, 2);
	await expectLevel('portalEditor', pe, rb, AUTHZ_READ_BUTTON_NEW, 1);
	await expectLevel('portalEditor', pe, AUTHZ_NO_BUTTON_SECTION, AUTHZ_NO_BUTTON_SECTION, 2);
	await expectLevel('portalEditor', pe, AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_SECTION, 2);
	const offButton = AUTHZ_OFF_TARGET_BUTTON_NEW;
	await expectLevel('portalEditor', pe, AUTHZ_OFF_TARGET_SECTION, offButton, 2);
	await expectLevel('portalEditor', pe, USERS_SECTION, USERS_SECTION, 0);
	await expectLevel('portalEditor', pe, PROFILES_SECTION, PROFILES_SECTION, 0);
	const ce = ids.childEditor;
	if (ce.isGlobalAdmin) problems.push('childEditor is a global admin');
	await expectLevel('childEditor', ce, AUTHZ_OFF_TARGET_SECTION, AUTHZ_OFF_TARGET_SECTION, 2);
	await expectLevel('childEditor', ce, AUTHZ_OFF_TARGET_SECTION, offButton, 0);
	for (const tipo of [AUTHZ_OFF_TARGET_CHILDREN, AUTHZ_OFF_TARGET_PARENT, AUTHZ_OFF_TARGET_ORDER]) {
		await expectLevel('portalEditor', pe, AUTHZ_OFF_TARGET_SECTION, tipo, 2);
		await expectLevel('childEditor', ce, AUTHZ_OFF_TARGET_SECTION, tipo, 2);
	}
	// The section-level create doors' contrast: every feature section writable,
	// test3 + its portal writable with its button_new at 0, test6100 likewise.
	const fe = ids.featureEditor;
	if (fe.isGlobalAdmin) problems.push('featureEditor is a global admin');
	for (const tipo of AUTHZ_FEATURE_SECTIONS) await expectLevel('featureEditor', fe, tipo, tipo, 2);
	await expectLevel('featureEditor', fe, AUTHZ_SECTION, AUTHZ_SECTION, 2);
	await expectLevel('featureEditor', fe, AUTHZ_SECTION, AUTHZ_PORTAL, 2);
	await expectLevel('featureEditor', fe, AUTHZ_SECTION, AUTHZ_BUTTON_NEW, 0);
	await expectLevel('featureEditor', fe, rb, rb, 2);
	await expectLevel('featureEditor', fe, rb, AUTHZ_READ_BUTTON_NEW, 0);
	if (problems.length > 0) {
		throw new Error(`authz_door_fixture: the contrast is degraded — ${problems.join('; ')}`);
	}
}
