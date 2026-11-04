/**
 * READ-DOOR ACL TRIPWIRE — every record-addressing READ door is classified
 * against the component read grant, and a new door cannot ship unclassified
 * (P1-3 — SEC-04, SEC-06, SEC-10, SEC-11, SEC-12, SEC-13).
 *
 * THE DEFECT THIS GATE EXISTS FOR. The human read applies `ddoIsAuthorized`
 * per component; six other doors returned component VALUES behind a section
 * grant or a record-scope check only. The shape was never carelessness at one
 * site — it was that authorization was a call a door made rather than a
 * property the read path had, so every new door re-implemented a subset. The
 * fix is `src/core/security/read_door.ts` (one law, one predicate) and THIS
 * census, which makes "which doors consult the component grant" a mechanical
 * fact rather than an audit finding.
 *
 * WHAT IS PINNED:
 *
 *  A. CENSUS: TOTAL, DERIVED. The door set is `listRegisteredActions()` (the
 *     dispatch registry) + `TOOL_REGISTRY` (the MCP registry) + the enumerated
 *     extra doors outside both (`READ_DOOR_EXTRA_DOORS`, each naming a file
 *     that must exist). Every key is classified in `READ_DOOR_POSTURE`; no
 *     stale key survives. Floors: ≥ 90 actions, ≥ 10 read tools, ≥ 110 keys.
 *
 *  B. THE `component` POSTURE NAMES ITS GATE, and the gate PROBES IT. Each
 *     `component` entry names a test file; the file exists and mentions the
 *     door by its action / tool name, so a classification cannot point at a
 *     gate that never exercises it.
 *
 *  C. THE `open` POSTURE IS ENUMERATED AND SHRINK-ONLY. Each open door carries
 *     a reason of substance; the set is frozen as a CEILING (members may leave
 *     when they close; a new one is a NEW hole and is refused). `mutating` and
 *     `delegates` are out of scope by declaration; `chokepoint` names the
 *     chokepoint and the file it lives in exists.
 *
 *  D. THE SIX DOORS OF THE FINDING are `component` (or, for the path reader,
 *     the frontier-scoped hop) — pinned by name so a re-classification to
 *     `open` is a visible diff, not a quiet regression. The path reader's leg
 *     is an OUTCOME, not a spelling scan of its wirings: `readPathValues`
 *     refuses an absent scope (`internal.invariant`), and the scope property
 *     is required at the type level, so an unscoped wiring cannot compile.
 *
 *  E. THE READER'S OWN PROPERTIES, no database: the door predicate is
 *     the human read's pair — the SECTION grant AND the component's (an
 *     injected grant of 0 on either refuses, 1 on both admits, an absent
 *     principal gates nothing, an unresolvable section fails closed);
 *     `projectAuthorizedColumns` keeps exactly the granted keys and never
 *     turns a present column into null; `authorizeComponentRead` throws
 *     `perm.denied`, the registry code. Positive-control offenders are
 *     constructed for each.
 *
 *  F. THE HUMAN READ'S WRITE SIDE (2026-10-30, the external-mirror refresh —
 *     a portal's `get_data_external` read recomputes its derived mirror). The
 *     read stays a `chokepoint`; its ONE write-capable reach is
 *     read_facade → maybeRefreshExternal, and the only write inside it runs
 *     AFTER the one `authorizeRecordAccess` (read level 1, door
 *     `dd_core_api.read.refresh_external`) and audits as that grant's actor.
 *     SPELLING PINS, labelled as such: they read comment-stripped source. The
 *     OUTCOME halves are the closure's B4 rows (write_obligations_tripwire —
 *     refreshExternalMirror ← runRefresh ← maybeRefreshExternal, exactly) and
 *     write_door_native (the door's level-1 grant).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_REGISTRY } from '../../src/ai/mcp/registry.ts';
import { listRegisteredActions } from '../../src/core/api/dispatch.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { internalPathReadScope, readPathValues } from '../../src/core/identify/path_read.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	authorizeComponentRead,
	doorComponentAllowed,
	projectAuthorizedColumns,
	READ_DOOR_EXTRA_DOORS,
	READ_DOOR_GATE,
	READ_DOOR_POSTURE,
	type ReadDoorPosture,
} from '../../src/core/security/read_door.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const actionKeys = listRegisteredActions().map((p) => `${p.apiClass}:${p.action}`);
const toolKeys = TOOL_REGISTRY.map((spec) => `mcp:${spec.name}`);
const extraKeys = READ_DOOR_EXTRA_DOORS.map((door) => door.key);
const census = [...actionKeys, ...toolKeys, ...extraKeys];

/**
 * THE OPEN CEILING — the doors that read component values behind a section
 * grant / record scope only, measured 2026-09-03 (7); the two AV reads closed
 * 2026-09-30 (closure Step 3, SEC-2-media → 5). Shrink-only: remove an entry
 * when its door closes; a new entry is a new hole and is refused here.
 */
const OPEN_CEILING: ReadonlySet<string> = new Set([
	'dd_core_api:get_section_terms',
	'dd_core_api:get_indexation_grid',
	'dd_component_text_area_api:get_tags_info',
	'dd_component_info:get_widget_data',
	'dd_utils_api:convert_search_object_to_sql_query',
]);

/** The six doors of the finding, and the posture each must hold. */
const FINDING_DOORS: readonly { key: string; posture: ReadDoorPosture['posture'] }[] = [
	{ key: 'dd_core_api:read_raw', posture: 'component' },
	{ key: 'mcp:dedalo_get_media_info', posture: 'component' },
	{ key: 'dd_identify_api:find_matches', posture: 'component' },
	{ key: 'dd_identify_api:identify_by_image', posture: 'component' },
	{ key: 'dd_core_api:get_element_context', posture: 'component' },
	{ key: 'http:GET /dedalo/core/api/v1/raw', posture: 'component' },
];

function postureOf(key: string): ReadDoorPosture {
	const entry = READ_DOOR_POSTURE.get(key);
	if (entry === undefined) throw new Error(`${key} is not classified`);
	return entry;
}

/**
 * The THIRD source of read doors: the loaded tools' HTTP routes
 * (ToolServerModule.httpRoutes — tool_export's artifact download serves record
 * data outside both registries above). Each route classifies ITSELF
 * (`readPosture`, required by the loader, never `open`); the census reads the
 * loaded registry, so a route any tool root adds later is in it.
 */
const { loadToolModules } = await import('../../src/core/tools/loader.ts');
const toolRoutes: { key: string; posture: unknown }[] = [];
for (const loaded of (await loadToolModules()).values()) {
	for (const route of loaded.module.httpRoutes ?? []) {
		toolRoutes.push({ key: `http:GET ${route.pathPrefix}`, posture: route.readPosture });
	}
}

describe('A0 — tool HTTP routes are in the census, each classified by its own declaration', () => {
	test("anti-vacuity: tool_export's artifact download is a census door", () => {
		expect(toolRoutes.map((route) => route.key)).toContain('http:GET /dedalo/export/artifact/');
	});

	test('every loaded tool route carries a closed, non-open posture (the loader refuses the rest)', async () => {
		const { readPostureRefusal } = await import('../../src/core/tools/loader.ts');
		for (const route of toolRoutes) {
			expect(readPostureRefusal(route.posture), route.key).toBeNull();
			expect((route.posture as { posture: string }).posture, route.key).not.toBe('open');
		}
		// positive control: the rule this relies on refuses the offenders
		expect(readPostureRefusal(undefined)).not.toBeNull();
		expect(readPostureRefusal({ posture: 'open', reason: 'ungated values' })).not.toBeNull();
	});

	test('a tool route never shadows a classified engine door', () => {
		for (const route of toolRoutes) expect(READ_DOOR_POSTURE.has(route.key), route.key).toBe(false);
	});
});

describe('A — the census is TOTAL and DERIVED', () => {
	test('anti-vacuity floors: both registries are populous', () => {
		// Measured 2026-09-03: 90 actions, 10 read tools, 1 extra door; 88 actions since
		// 2026-10-12 (dd_utils_api get_install_context + install removed —
		// WC-2026-10-12-install-surface-removed).
		expect(actionKeys.length).toBeGreaterThanOrEqual(88);
		expect(TOOL_REGISTRY.filter((spec) => !spec.write).length).toBeGreaterThanOrEqual(10);
		expect(census.length).toBeGreaterThanOrEqual(108); // 110 until the two install actions left (2026-10-12)
		expect(new Set(census).size).toBe(census.length);
	});

	test('every registered action, every MCP tool and every extra door is classified', () => {
		const unclassified = census.filter((key) => !READ_DOOR_POSTURE.has(key)).sort();
		expect(
			unclassified,
			'A door is UNCLASSIFIED against the component read grant. Classify it in READ_DOOR_POSTURE (src/core/security/read_door.ts): `component` with a gate that probes it, a named `chokepoint`, `record_identity`, `structure_only`, `mutating`, `delegates` — or `open` with the reason, which this gate refuses to grow.',
		).toEqual([]);
	});

	test('no stale key: the map classifies nothing the registries do not hold', () => {
		const known = new Set(census);
		const stale = [...READ_DOOR_POSTURE.keys()].filter((key) => !known.has(key)).sort();
		expect(stale).toEqual([]);
		expect(READ_DOOR_POSTURE.size).toBe(census.length);
	});

	test('every extra door names a file that exists', async () => {
		expect(READ_DOOR_EXTRA_DOORS.length).toBeGreaterThan(0);
		for (const door of READ_DOOR_EXTRA_DOORS) {
			expect(await Bun.file(door.file).exists(), door.file).toBe(true);
		}
	});

	test('every reason is of substance', () => {
		for (const [key, entry] of READ_DOOR_POSTURE) {
			expect(entry.reason.length, key).toBeGreaterThan(6);
		}
	});
});

describe('B — a `component` door names a gate that probes it', () => {
	const componentDoors = [...READ_DOOR_POSTURE.entries()].filter(
		(entry): entry is [string, Extract<ReadDoorPosture, { posture: 'component' }>] =>
			entry[1].posture === 'component',
	);

	test('there are component doors (floor 5), and each names an existing gate', async () => {
		expect(componentDoors.length).toBeGreaterThanOrEqual(5);
		for (const [key, entry] of componentDoors) {
			expect(await Bun.file(entry.gate).exists(), `${key} → ${entry.gate}`).toBe(true);
		}
	});

	test('the named gate mentions the door by name', async () => {
		for (const [key, entry] of componentDoors) {
			const source = await Bun.file(entry.gate).text();
			// The registry action / tool name, or the extra door's route.
			const name = key.startsWith('http:') ? key.slice('http:'.length) : (key.split(':')[1] ?? key);
			expect(source.includes(name), `${entry.gate} never names ${name}`).toBe(true);
		}
	});

	test("this batch's gate probes EVERY component door that names it", async () => {
		const source = await Bun.file(READ_DOOR_GATE).text();
		const mine = componentDoors.filter(([, entry]) => entry.gate === READ_DOOR_GATE);
		expect(mine.length).toBeGreaterThanOrEqual(5);
		for (const [key] of mine) {
			const name = key.startsWith('http:') ? key.slice('http:'.length) : (key.split(':')[1] ?? key);
			expect(source.includes(name), `${READ_DOOR_GATE} never probes ${name}`).toBe(true);
		}
	});
});

describe('C — the open set is enumerated, reasoned and shrink-only', () => {
	const open = [...READ_DOOR_POSTURE.entries()]
		.filter(([, entry]) => entry.posture === 'open')
		.map(([key]) => key);

	test('every open door is in the frozen ceiling; every ceiling entry is still open', () => {
		const beyond = open.filter((key) => !OPEN_CEILING.has(key)).sort();
		expect(
			beyond,
			'A door was newly classified `open` — a NEW component-grant hole. Close it at the door (read_door.ts) instead; the ceiling does not grow.',
		).toEqual([]);
		const stale = [...OPEN_CEILING].filter((key) => !open.includes(key)).sort();
		expect(stale, 'a door closed — remove it from OPEN_CEILING').toEqual([]);
	});

	test('every open reason says what is NOT consulted (floor 60 chars, names the grant)', () => {
		for (const key of open) {
			const entry = postureOf(key);
			expect(entry.reason.length, key).toBeGreaterThan(60);
			expect(/grant|scope/.test(entry.reason), key).toBe(true);
		}
	});

	test('every chokepoint names a file that exists', async () => {
		const chokepoints = [...READ_DOOR_POSTURE.entries()].filter(
			(entry): entry is [string, Extract<ReadDoorPosture, { posture: 'chokepoint' }>] =>
				entry[1].posture === 'chokepoint',
		);
		expect(chokepoints.length).toBeGreaterThan(10);
		for (const [key, entry] of chokepoints) {
			const file = entry.via.split(' ')[0] ?? '';
			expect(file.startsWith('src/'), `${key}: '${entry.via}' must start with the file`).toBe(true);
			expect(await Bun.file(file).exists(), `${key} → ${file}`).toBe(true);
		}
	});
});

describe('D — the six doors of the finding hold their posture', () => {
	for (const door of FINDING_DOORS) {
		test(door.key, () => {
			expect(postureOf(door.key).posture).toBe(door.posture);
		});
	}
	test('the criterion path reader REFUSES a read with no scope — an unscoped wiring cannot exist', async () => {
		// The DECISION itself (declared ≠ landed → refused, the record key) is
		// driven behaviourally in identify_path_read.test.ts and identify_match.
		// This leg pins the OUTCOME that makes an unscoped wiring impossible
		// anywhere in the engine, not the spelling of the wirings that exist:
		// `PathReadOptions.scope` is REQUIRED (tsc, verify.ts step 1 — a wiring
		// that omits it or binds `undefined` does not compile) and the reader
		// throws `internal.invariant` BEFORE its swallowing try, so a scope lost
		// through a cast reads as a contract violation, never as "absent". The
		// throw is the FIRST thing the reader does.
		// An UNRESOLVABLE seed tipo: the walk can only end in null (with or
		// without a database), so the only observable difference between the
		// three calls below is the guard itself.
		const seed = { sectionTipo: 'zznope999', sectionId: 1 };
		const path = [{ section_tipo: 'zznope999', component_tipo: 'zznope998' }];
		const refusal = await readPathValues(seed, path, {} as never).then(
			() => null,
			(error: unknown) => error,
		);
		expect(refusal).toBeInstanceOf(DedaloError);
		expect((refusal as DedaloError).code).toBe('internal.invariant');
		const bound = await readPathValues(seed, path, { scope: undefined } as never).then(
			() => null,
			(error: unknown) => error,
		);
		expect((bound as DedaloError).code).toBe('internal.invariant');
		// POSITIVE CONTROL: a DECLARED internal scope passes the same guard —
		// the walk proceeds and ends in null (unresolvable seed) instead of a
		// throw, so the refusals above are the guard, not the walk.
		expect(await readPathValues(seed, path, { scope: internalPathReadScope('gate') })).toBeNull();
	});
});

describe('E — the door predicate, no database', () => {
	const principal: Principal = { userId: 4242, isGlobalAdmin: false, isDeveloper: false };
	const grantOf = (level: number) => async () => level;

	test('an injected grant of 0 refuses, 1 admits; an absent principal gates nothing', async () => {
		const step = { sectionTipo: 'test3', componentTipo: 'test52' };
		expect(await doorComponentAllowed({ principal, door: 'gate', grant: grantOf(0) }, step)).toBe(
			false,
		);
		expect(await doorComponentAllowed({ principal, door: 'gate', grant: grantOf(1) }, step)).toBe(
			true,
		);
		expect(await doorComponentAllowed({ door: 'gate', grant: grantOf(0) }, step)).toBe(true);
	});

	test('the component key is the human read’s PAIR: the section grant AND the component’s — either at 0 refuses (SEC-11)', async () => {
		const step = { sectionTipo: 'test3', componentTipo: 'test52' };
		const asked: string[] = [];
		const only = (granted: string) => ({
			principal,
			door: 'gate',
			grant: async (_p: Principal, s: string, c: string) => {
				asked.push(`${s}|${c}`);
				return c === granted ? 1 : 0;
			},
		});
		// Component granted WITHOUT its section — the misconfigured-matrix shape
		// the human read refuses (dd_core_api Gate A/B): refused here too.
		expect(await doorComponentAllowed(only('test52'), step)).toBe(false);
		// Section granted, component at 0: refused (the finding's own shape).
		expect(await doorComponentAllowed(only('test3'), step)).toBe(false);
		// Both asked, the section first — a refusal on it never reaches the component.
		expect(asked.length).toBeGreaterThanOrEqual(2);
		expect(asked[0]).toBe('test3|test3');
		expect(asked).toContain('test3|test52');
	});

	test('an unresolvable section fails CLOSED even under a granting reader (SEC-01)', async () => {
		const asked: string[] = [];
		const scope = {
			principal,
			door: 'gate',
			grant: async (_p: Principal, s: string) => {
				asked.push(s);
				return 3;
			},
		};
		expect(await doorComponentAllowed(scope, { sectionTipo: '', componentTipo: 'x' })).toBe(false);
		expect(asked).toEqual([]);
	});

	test('authorizeComponentRead throws the registry code perm.denied, and passes when granted', async () => {
		const step = { sectionTipo: 'test3', componentTipo: 'test52', sectionId: 7 };
		const refusal = await authorizeComponentRead(
			{ principal, door: 'gate', grant: grantOf(0) },
			step,
		).then(
			() => null,
			(error: unknown) => error,
		);
		expect(refusal).toBeInstanceOf(DedaloError);
		expect((refusal as DedaloError).code).toBe('perm.denied');
		await expect(
			authorizeComponentRead({ principal, door: 'gate', grant: grantOf(1) }, step),
		).resolves.toBeUndefined();
	});

	test('projectAuthorizedColumns keeps EXACTLY the granted keys; a null column stays null, an emptied one is {}', async () => {
		const columns = {
			string: { a1: ['keep'], b1: ['drop'] },
			relation: { b1: [{ section_tipo: 'x', section_id: 1 }] },
			date: null,
			misc: { c1: 'drop' },
		};
		const scope = {
			principal,
			door: 'gate',
			// The section itself is granted (the pair's first leg); a1 is the one
			// component the caller may read.
			grant: async (_p: Principal, _s: string, componentTipo: string) =>
				componentTipo === 'a1' || componentTipo === 'test3' ? 1 : 0,
		};
		const projected = await projectAuthorizedColumns(
			scope,
			{ sectionTipo: 'test3', sectionId: 1 },
			columns,
		);
		expect(projected).toEqual({ string: { a1: ['keep'] }, relation: {}, date: null, misc: {} });
		// Positive control: the same columns with everything granted are identical.
		const all = await projectAuthorizedColumns(
			{ principal, door: 'gate', grant: grantOf(1) },
			{ sectionTipo: 'test3', sectionId: 1 },
			columns,
		);
		expect(all).toEqual(columns);
		// And an internal read (no principal) is the identity.
		expect(
			await projectAuthorizedColumns(
				{ door: 'gate' },
				{ sectionTipo: 'test3', sectionId: 1 },
				columns,
			),
		).toEqual(columns);
	});
});

describe('F — the human read’s write side goes through ONE grant', () => {
	const root = join(import.meta.dir, '..', '..');
	const codeOf = (rel: string): string => stripComments(readFileSync(join(root, rel), 'utf8'));
	const facade = codeOf('src/core/section/read_facade.ts');
	const door = codeOf('src/core/section/record/external_refresh.ts');
	const count = (text: string, needle: string): number => text.split(needle).length - 1;

	test('dd_core_api:read stays the human-read chokepoint', () => {
		expect(postureOf('dd_core_api:read').posture).toBe('chokepoint');
	});

	test('the read facade reaches the write graph ONCE: the refresh door, before the component read', () => {
		expect(count(facade, "import('./record/external_refresh.ts')")).toBe(1);
		expect(count(facade, 'maybeRefreshExternal(rqo, principal)')).toBe(1);
		const refreshAt = facade.indexOf('maybeRefreshExternal(rqo, principal)');
		const readAt = facade.indexOf('await readComponentDataEmission(rqo);');
		expect(readAt).toBeGreaterThan(refreshAt);
		// no other write door is imported by the read facade
		for (const writer of ['observers.ts', 'save_component.ts', 'record_write.ts']) {
			expect(facade, `read_facade imports ${writer}`).not.toContain(writer);
		}
	});

	// The AUTHORIZATION DECISION itself (refused at 0 and nothing written; granted at
	// 1 with the reader as the TM actor) is DRIVEN, not pinned by spelling
	// (authz_substring_gate_tripwire): external_refresh_native "the portal at 0: the
	// read is withheld and the door refuses — nothing written" and "a non-admin
	// reader holding the portal at 1 refreshes; the TM actor is the reader".
	test('inside the door: the only write takes the runner’s grant (its userId is the TM actor)', () => {
		expect(door).toContain(
			"{ mode: 'read', level: 1, sectionFloor: 1, door: EXTERNAL_REFRESH_DOOR }",
		);
		expect(door).toContain(
			"export const EXTERNAL_REFRESH_DOOR = 'dd_core_api.read.refresh_external';",
		);
		expect(count(door, 'refreshExternalMirror(')).toBe(1);
		const runAt = door.indexOf('async function runRefresh(');
		const writeAt = door.indexOf('refreshExternalMirror(');
		const runEnd = door.indexOf('\n}\n', runAt);
		expect(runAt).toBeGreaterThan(-1);
		expect(writeAt).toBeGreaterThan(runAt);
		expect(writeAt).toBeLessThan(runEnd);
		expect(door.slice(runAt, runEnd)).toContain('grant: RecordGrant');
		expect(door.slice(writeAt, runEnd)).toContain('grant.userId');
	});
});
