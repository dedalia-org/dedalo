/**
 * HIER-REBUILD — the hierarchy rebuild / registry-delete TEARDOWN SCOPE gates.
 *
 * The defect (plan HIER-REBUILD, owner decisions D1-D10 all decided 2026-11-10):
 * `rebuildHierarchy` (tool_hierarchy `generate_virtual_section` with
 * `force_to_create:true`, gate = level 2 on `hierarchy1/<id>`) reads the TLD from
 * the EDITABLE `hierarchy6` literal and calls `deleteOntologyByTld` with no
 * ownership / core / shape check, and deletes BEFORE it validates that the
 * re-provisioning can succeed. The `dd_core_api` delete of a registry record
 * (door B, global admin) trusts the same literal. `ensureHierarchy` provisions
 * `<tld>0/1/2` for a root-only (case 2) row whose hierarchy53 names a foreign
 * defined section.
 *
 * The contract these gates pin (the fixed behaviour):
 *  - force rebuild only for an OWNED case 1 hierarchy (tld not core / not
 *    `test`; the row is the SOLE hierarchy1 record declaring the tld;
 *    `<tld>1`/`<tld>2`, when present, are `section` nodes each a virtual of ONE
 *    existing real section OUTSIDE the tld — read from dd_ontology, never from
 *    hierarchy109/53; hierarchy53 unset or `<tld>1`; provisioning
 *    preconditions valid BEFORE the first delete; teardown + provision in one
 *    transaction). Force = from scratch (D10): all tld nodes, all `<tld>0`
 *    records (extras incl.), the tld's ontology35 row — then re-provisioned.
 *    `<tld>1` TERMS are never touched. Without force nothing is deleted.
 *  - a refusal is ONE error code with a `reason` extension key ∈ {core,
 *    not_sole_declarer, root_only, ontology_package, invalid_source} (D4).
 *    {@link REFUSAL_CODE} is the PROPOSED code name — the implementer aligns
 *    the constant with the registry entry it adds; every refusal assertion
 *    also checks that NOTHING was written (the byte snapshot of the tld).
 *
 * Doors are driven for real: door A through `dispatchRqo` → dd_tools_api
 * `tool_request` → `dispatchToolRequest` (tool grant, 'targets' permission gate,
 * handler); the hijack's hierarchy6 write through `dispatchRqo` → dd_core_api
 * `save`; door B through `dispatchRqo` → dd_core_api `delete` (delete_record).
 *
 * HEAD (43dc10c2ed) — expected RED: G1, G2, G2b second shape, G2c, G3, G6
 * duplicate half, G7. Green on HEAD by design: G2a (a behaviour PIN for D10,
 * not a fix gate) and G4 (the control). Each red must fail on its behavioural
 * assertion (a served answer where a refusal is due, or a changed snapshot),
 * never on a setup step — every setup precondition is asserted separately.
 *
 * CORE cases — G5 and the core half of G6 (armed with the fix, see
 * CORE_CASES_ARMED): on HEAD they WOULD delete a core TLD (`rsc`, `lg`) or the
 * suite's `test` TLD from the SHARED suite database. Their RED proof is by
 * mutation AFTER the fix, on a disposable clone (`createdb -T <suite db>`) —
 * never on HEAD, never on the shared suite DB with the fix absent. The ONE
 * guard against a regressed fix is the transaction they run in, which is
 * ALWAYS rolled back (the registry row is created inside it too). The
 * throwing deleteRecord handed to rebuild guards NOTHING: retractOntology
 * purges the tld's dd_ontology nodes before the first deleteRecord call. So
 * each core case first asks the PURE predicate (classifyHierarchyRebuild /
 * assertRegistryCascadeAllowed) and fails WITHOUT calling the door unless it
 * answers `core` — a regressed predicate never reaches a teardown.
 *
 * Fault-injection rollback (G7b, G10, G11, G12): through rebuild's OWN
 * injected deleteRecord (no engine hook) — G7b strips the row's typology, so
 * the re-provisioning fails after the teardown; G10 runs a real SQL error
 * (division by zero) mid-teardown; G11 creates, inside the rebuild's own
 * transaction, a BEFORE INSERT trigger on matrix_ontology that raises for
 * `<tld>0`/2 — a real Postgres error inside provisioning (rolled back with the
 * transaction: the trigger never commits). G12 does the same to the
 * non-fatal permission grant (matrix_profiles) inside an always-rolled-back
 * transaction. Each asserts ok:false (or ok for the non-fatal grant), the
 * injected error named — not a 25P02 "transaction is aborted" — and nothing
 * changed.
 *
 * Scratch: TLDs `zzrs*` only (letters only — safeTld), registry rows allocated
 * through the counter door, package TLDs built through the engine's own writers
 * (ensureMainSection + createDdOntologyRootNode + matrix_ontology records
 * projected by insertDdOntologyRecord), foreign sections through a `zzrsx`
 * situation. afterAll sweeps every tld, record, TM row, counter and the
 * provisioning grants on the acting profiles, then asserts zero `zzrs%` rows.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { deleteTldNodes } from '../../src/core/db/dd_ontology.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import {
	insertMatrixRecordWithCounter,
	insertMatrixRecordWithExplicitId,
} from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	classifyHierarchyRebuild,
	ensureHierarchy,
	rebuildHierarchy,
} from '../../src/core/ontology/hierarchy_state.ts';
import {
	assertRegistryCascadeAllowed,
	deleteOntologyByTld,
} from '../../src/core/ontology/ontology_delete.ts';
import {
	createDdOntologyRootNode,
	ensureMainSection,
	insertDdOntologyRecord,
} from '../../src/core/ontology/ontology_write.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession, type Session } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	modelTipoFor,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { invalidateAllToolCaches } from '../../src/core/tools/cache.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { assertActionPermission, resolveAction } from '../../src/core/tools/security.ts';
import { scopeBindingSlot } from '../helpers/scope_binding_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

/**
 * THE PROPOSED refusal code (plan §5 / D4: one code + a `reason` extension key).
 * Not registered on HEAD — the implementer adds the registry entry and aligns
 * this constant to it.
 */
const REFUSAL_CODE = 'ontology.teardown_refused';

/**
 * ARMED with the fix: the core refusal is the classification's FIRST probe and
 * deleteOntologyByTld's own guard, both before any write (verified: a rolled-back
 * transaction + a throwing deleteRecord, and the refusal precedes both).
 */
const CORE_CASES_ARMED = true;

const ROOT = -1;
const REGISTRY = 'hierarchy1';
const REGISTRY_TABLE = 'matrix_hierarchy_main';
const ONTOLOGY_MAIN = 'ontology35';
const ONTOLOGY_MAIN_TABLE = 'matrix_ontology_main';
const NODE_TABLE = 'matrix_ontology';
/** The thesaurus template every provisioned hierarchy is a virtual of. */
const THESAURUS = 'hierarchy20';
/** A component of hierarchy1 — a tipo that is NOT a section (G7's invalid source). */
const NOT_A_SECTION = 'hierarchy6';

/** Every scratch tld of this file (letters only: safeTld /^[a-z]{2,}$/). */
const TLD = {
	attacker: 'zzrsa',
	victim: 'zzrsv',
	package: 'zzrsp',
	legacy: 'zzrsl',
	rootOnly: 'zzrsr',
	realOne: 'zzrst',
	ensureCase2: 'zzrsq',
	duplicate: 'zzrsd',
	control: 'zzrsc',
	invalid: 'zzrsi',
	doorB: 'zzrsb',
	fault: 'zzrsf',
	halfProjected: 'zzrsm',
	mainOnly: 'zzrsn',
	sourcelessNode: 'zzrso',
	unprojectedRecord: 'zzrsu',
	straySibling: 'zzrss',
	sqlFault: 'zzrsg',
	provisionFault: 'zzrsh',
	grantFault: 'zzrsw',
	multiOwned: 'zzrse',
	multiShared: 'zzrsk',
	inspect: 'zzrsj',
} as const;
const SCRATCH_TLDS: readonly string[] = Object.values(TLD);
const SCRATCH_TLD = /^zzrs[a-z]+$/;

/** The foreign DEFINED sections case 2 rows point at (a situation, outside every tld above). */
const FOREIGN = situation({
	tld: 'zzrsx',
	name: 'hierarchy_rebuild_scope foreign sections',
	nodes: [
		{ tipo: 'zzrsx1', model: 'section' },
		{ tipo: 'zzrsx2', model: 'section' },
		{ tipo: 'zzrsx3', model: 'section' },
		{ tipo: 'zzrsx4', model: 'section' },
		// Each section's "New" button: a root term minted in a DECLARED (not own)
		// section runs under the acting principal's New-button predicate (T0-2).
		{ tipo: 'zzrsx11', model: 'button_new', parent: 'zzrsx1' },
		{ tipo: 'zzrsx12', model: 'button_new', parent: 'zzrsx2' },
		{ tipo: 'zzrsx13', model: 'button_new', parent: 'zzrsx3' },
		{ tipo: 'zzrsx14', model: 'button_new', parent: 'zzrsx4' },
	],
});

/** The scope-binding fixture: user A gets hierarchy1 = 2 + hierarchy6 = 2 (the hijack persona). */
const sb = scopeBindingSlot();

let root: Principal;
let attacker: Principal;

/** Every registry row this file created (swept in afterAll). */
const registryRows: number[] = [];
/** Every ontology35 id ever observed for a scratch tld (their TM rows are swept). */
const mainIdsSeen = new Set<number>();
const sessions = new Map<number, Session>();

// --- plumbing --------------------------------------------------------------------

function contextFor(principal: Principal): ApiRequestContext {
	let session = sessions.get(principal.userId);
	if (session === undefined) {
		const token = createSession(
			principal.userId,
			`zzrs_rebuild_scope_${principal.userId}`,
			principal.isGlobalAdmin,
		);
		session = getSession(token) as Session;
		sessions.set(principal.userId, session);
	}
	return {
		requestId: crypto.randomUUID(),
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session.csrfToken,
		principal,
	} as ApiRequestContext;
}

/** What a door answered: ok, the refusal code and its `reason` extension key. */
interface Answer {
	ok: boolean;
	code: string | null;
	reason: unknown;
	status: number;
	message: string;
}

async function answerOf(run: () => Promise<unknown>): Promise<Answer> {
	try {
		const value = (await run()) as {
			status?: number;
			body?: { ok?: boolean; reason?: unknown; error?: Record<string, unknown> };
		};
		const body = value?.body ?? {};
		const error = body.error ?? {};
		return {
			ok: body.ok === true,
			code: typeof error.code === 'string' ? error.code : null,
			reason: body.reason ?? error.reason ?? null,
			status: value?.status ?? 0,
			message: String(error.message ?? error.public_message ?? ''),
		};
	} catch (error) {
		if (isDedaloError(error)) {
			return {
				ok: false,
				code: error.code,
				reason: error.extend?.reason ?? null,
				status: error.spec.status,
				message: error.message,
			};
		}
		return {
			ok: false,
			code: `untyped: ${(error as Error).message}`,
			reason: null,
			status: 500,
			message: (error as Error).message,
		};
	}
}

/** The refusal contract's ANSWER half (the no-write half is the caller's snapshot compare). */
function expectRefusal(answer: Answer, reasons: readonly string[]): void {
	expect({
		ok: answer.ok,
		code: answer.code,
		reasonAllowed: reasons.includes(String(answer.reason)),
		reason: answer.reason,
	}).toEqual({
		ok: false,
		code: REFUSAL_CODE,
		reasonAllowed: true,
		reason: answer.reason, // echoed so a red names the reason it got
	});
}

/** Door A: tool_hierarchy.generate_virtual_section through the real tool_request dispatch. */
function generate(principal: Principal, rowId: number, force: boolean): Promise<Answer> {
	return answerOf(async () => {
		const answer = await dispatchRqo(
			{
				action: 'tool_request',
				dd_api: 'dd_tools_api',
				source: { model: 'tool_hierarchy', action: 'generate_virtual_section' },
				options: { section_tipo: REGISTRY, section_id: rowId, force_to_create: force },
			} as unknown as Rqo,
			contextFor(principal),
		);
		await clearOntologyDerivedCaches();
		return answer;
	});
}

/** Door B: dd_core_api delete (delete_record) of one registry row. */
function deleteRegistryRow(principal: Principal, rowId: number): Promise<Answer> {
	return answerOf(async () => {
		const answer = await dispatchRqo(
			{
				action: 'delete',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					model: 'section',
					tipo: REGISTRY,
					section_tipo: REGISTRY,
					section_id: rowId,
					action: 'delete',
					delete_mode: 'delete_record',
				},
			} as unknown as Rqo,
			contextFor(principal),
		);
		await clearOntologyDerivedCaches();
		return answer;
	});
}

/** The hijack's write: hierarchy6 through dd_core_api save, as `principal`. */
function saveTld(principal: Principal, rowId: number, value: string): Promise<Answer> {
	return answerOf(() =>
		dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					type: 'component',
					model: 'component_input_text',
					tipo: 'hierarchy6',
					section_tipo: REGISTRY,
					section_id: String(rowId),
					mode: 'edit',
					lang: 'lg-nolan',
				},
				data: {
					section_id: String(rowId),
					section_tipo: REGISTRY,
					tipo: 'hierarchy6',
					lang: 'lg-nolan',
					changed_data: [{ action: 'update', id: 1, value: { id: 1, lang: 'lg-nolan', value } }],
				},
			} as unknown as Rqo,
			contextFor(principal),
		),
	);
}

const yesLocator = (from: string) => ({
	id: 1,
	type: 'dd151',
	section_id: 1,
	section_tipo: 'dd64',
	from_component_tipo: from,
});

/** One hierarchy1 row through the counter door: active, typology, name, tld, source. */
async function createRegistryRow(
	tld: string,
	options: { source?: string; terms?: string; model?: string } = {},
): Promise<number> {
	const string: Record<string, unknown[]> = {
		hierarchy5: [{ id: 1, lang: 'lg-eng', value: `zzrs rebuild scope ${tld}` }],
		hierarchy6: [{ id: 1, lang: 'lg-nolan', value: tld.toUpperCase() }],
		hierarchy109: [{ id: 1, lang: 'lg-nolan', value: options.source ?? THESAURUS }],
	};
	if (options.terms !== undefined)
		string.hierarchy53 = [{ id: 1, lang: 'lg-nolan', value: options.terms }];
	if (options.model !== undefined)
		string.hierarchy58 = [{ id: 1, lang: 'lg-nolan', value: options.model }];
	const sectionId = await insertMatrixRecordWithCounter(REGISTRY_TABLE, REGISTRY, {
		string,
		relation: {
			hierarchy4: [yesLocator('hierarchy4')],
			hierarchy9: [
				{
					id: 1,
					type: 'dd151',
					section_id: 2,
					section_tipo: 'hierarchy13',
					from_component_tipo: 'hierarchy9',
				},
			],
		},
	});
	registryRows.push(sectionId);
	return sectionId;
}

/** Provision a case 1 hierarchy through the engine's own converge (as root). */
async function provision(rowId: number): Promise<void> {
	const outcome = await ensureHierarchy(rowId, ROOT);
	await clearOntologyDerivedCaches();
	if (!outcome.ok)
		throw new Error(`setup: ensureHierarchy(${rowId}) failed: ${outcome.errors.join('; ')}`);
}

interface NodeSpec {
	id: number;
	parent: string;
	model: string;
	relations?: string[];
}

/** A locator to a node tipo (`<tld>0`/<id>), the shape the export/import writes. */
function nodeLocator(tipo: string, from: string, type: string, id: number) {
	const match = /^([a-z]+)(\d+)$/.exec(tipo);
	if (match === null) throw new Error(`setup: '${tipo}' is not a tipo`);
	return {
		id,
		type,
		section_id: Number(match[2]),
		section_tipo: `${match[1]}0`,
		from_component_tipo: from,
	};
}

/**
 * One ontology node of `tld` through the engine's writers: the `<tld>0/<id>`
 * matrix_ontology record (the import's column shape — ontology15 parent,
 * ontology6 model, ontology10 relations, ontology5 term, ontology7 tld) and its
 * dd_ontology projection (insertDdOntologyRecord, the parser).
 */
async function addNode(tld: string, node: NodeSpec): Promise<void> {
	await addNodeRecord(tld, node);
	const sectionTipo = `${tld}0`;
	const projected = await insertDdOntologyRecord(sectionTipo, node.id);
	if (projected !== `${tld}${node.id}`)
		throw new Error(`setup: ${sectionTipo}/${node.id} did not project (got ${projected})`);
}

/** The `<tld>0/<id>` matrix_ontology record ALONE — never projected (a half-installed package). */
async function addNodeRecord(tld: string, node: NodeSpec): Promise<void> {
	const modelTipo = await modelTipoFor(node.model);
	const relation: Record<string, unknown[]> = {
		ontology15: [nodeLocator(node.parent, 'ontology15', 'dd47', 1)],
		ontology6: [nodeLocator(modelTipo, 'ontology6', 'dd151', 1)],
	};
	if ((node.relations ?? []).length > 0) {
		relation.ontology10 = (node.relations ?? []).map((tipo, index) =>
			nodeLocator(tipo, 'ontology10', 'dd151', index + 1),
		);
	}
	const sectionTipo = `${tld}0`;
	await insertMatrixRecordWithExplicitId(NODE_TABLE, sectionTipo, node.id, {
		data: { label: tld, section_id: node.id, section_tipo: sectionTipo },
		relation,
		string: {
			ontology5: [{ id: 1, lang: 'lg-spa', value: `${tld}${node.id} ${node.model}` }],
			ontology7: [{ id: 1, lang: 'lg-nolan', value: tld }],
		},
	});
}

/** An installed ONTOLOGY PACKAGE: its ontology35 row, the `<tld>0` root node and `nodes`. */
async function buildPackage(tld: string, nodes: readonly NodeSpec[]): Promise<void> {
	await ensureMainSection(
		{ tld, typology_id: 2, name_data: [{ id: 1, lang: 'lg-eng', value: `zzrs package ${tld}` }] },
		ROOT,
	);
	await createDdOntologyRootNode({ tld }, ROOT);
	for (const node of nodes) await addNode(tld, node);
	await clearOntologyDerivedCaches();
}

/** Everything a teardown could touch for `tld`, as text (ids included: a re-insert shows). */
interface TldSnapshot {
	nodes: string[];
	records: string[];
	main: string[];
}

async function snapshot(tld: string): Promise<TldSnapshot> {
	const nodes = (await sql.unsafe(
		`SELECT id, tipo, parent, model, relations::text AS relations, term::text AS term
		   FROM dd_ontology WHERE tld = $1 ORDER BY tipo`,
		[tld],
	)) as Record<string, unknown>[];
	const records = (await sql.unsafe(
		`SELECT section_id, data::text AS data, relation::text AS relation, string::text AS string
		   FROM "${NODE_TABLE}" WHERE section_tipo = $1 ORDER BY section_id`,
		[`${tld}0`],
	)) as Record<string, unknown>[];
	const main = (await sql.unsafe(
		`SELECT section_id, string::text AS string, relation::text AS relation
		   FROM "${ONTOLOGY_MAIN_TABLE}" WHERE section_tipo = $1 AND string @> $2::text::jsonb
		  ORDER BY section_id`,
		[ONTOLOGY_MAIN, encodeForJsonb({ hierarchy6: [{ value: tld }] })],
	)) as { section_id: number }[];
	for (const row of main) mainIdsSeen.add(Number(row.section_id));
	return {
		nodes: nodes.map((row) => JSON.stringify(row)),
		records: records.map((row) => JSON.stringify(row)),
		main: main.map((row) => JSON.stringify(row)),
	};
}

async function nodeTipos(tld: string): Promise<string[]> {
	const rows = (await sql.unsafe('SELECT tipo FROM dd_ontology WHERE tld = $1 ORDER BY tipo', [
		tld,
	])) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

async function nodeRecordIds(tld: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${NODE_TABLE}" WHERE section_tipo = $1 ORDER BY section_id`,
		[`${tld}0`],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

async function mainIds(tld: string): Promise<number[]> {
	return (await snapshot(tld)).main.map((row) => Number(JSON.parse(row).section_id));
}

/** A registry row's stored columns, as text (the no-write probe of the row itself). */
async function registryRowText(rowId: number): Promise<string> {
	const rows = (await sql.unsafe(
		`SELECT string::text AS string, relation::text AS relation FROM "${REGISTRY_TABLE}"
		  WHERE section_tipo = $1 AND section_id = $2`,
		[REGISTRY, rowId],
	)) as { string: string; relation: string }[];
	if (rows.length !== 1) return '<absent>';
	return `${rows[0]?.string}|${rows[0]?.relation}`;
}

async function registryLiteral(rowId: number, tipo: string): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		`SELECT string->'${tipo}' AS value FROM "${REGISTRY_TABLE}"
		  WHERE section_tipo = $1 AND section_id = $2`,
		[REGISTRY, rowId],
	)) as { value: unknown[] | null }[];
	return rows[0]?.value ?? [];
}

async function generalTermLocator(rowId: number): Promise<Record<string, unknown> | null> {
	const rows = (await sql.unsafe(
		`SELECT relation->'hierarchy45'->0 AS loc FROM "${REGISTRY_TABLE}"
		  WHERE section_tipo = $1 AND section_id = $2`,
		[REGISTRY, rowId],
	)) as { loc: Record<string, unknown> | null }[];
	return rows[0]?.loc ?? null;
}

/** The TERMS of a thesaurus section (never touched by any teardown). */
async function terms(sectionTipo: string): Promise<string[]> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) throw new Error(`setup: no matrix table for ${sectionTipo}`);
	const rows = (await sql.unsafe(
		`SELECT section_id, string::text AS string FROM "${table}"
		  WHERE section_tipo = $1 ORDER BY section_id`,
		[sectionTipo],
	)) as Record<string, unknown>[];
	return rows.map((row) => JSON.stringify(row));
}

/** One extra term in a provisioned `<tld>1` (beside the minted root). */
async function addTerm(sectionTipo: string, sectionId: number, name: string): Promise<void> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) throw new Error(`setup: no matrix table for ${sectionTipo}`);
	await insertMatrixRecordWithExplicitId(table, sectionTipo, sectionId, {
		data: { section_id: sectionId, section_tipo: sectionTipo },
		string: { hierarchy25: [{ id: 1, lang: 'lg-eng', value: name }] },
	});
}

async function recordCount(sectionTipo: string): Promise<number> {
	const table = (await getMatrixTableFromTipo(sectionTipo)) ?? 'matrix_test';
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${table}" WHERE section_tipo = $1`,
		[sectionTipo],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** Door A's read: tool_hierarchy.inspect_hierarchy through the real tool_request dispatch. */
async function inspectThroughTool(principal: Principal, rowId: number): Promise<unknown> {
	const answer = (await dispatchRqo(
		{
			action: 'tool_request',
			dd_api: 'dd_tools_api',
			source: { model: 'tool_hierarchy', action: 'inspect_hierarchy' },
			options: { section_tipo: REGISTRY, section_id: rowId },
		} as unknown as Rqo,
		contextFor(principal),
	)) as {
		body?: { ok?: boolean; data?: Record<string, unknown>; result?: Record<string, unknown> };
	};
	const data = answer.body?.data ?? answer.body?.result ?? {};
	return { ok: answer.body?.ok === true, rebuild: data.rebuild ?? null };
}

/** Door B, multi-delete: dd_core_api delete with an SQO pinning `rowIds` (global admin). */
function deleteRegistryRows(principal: Principal, rowIds: readonly number[]): Promise<Answer> {
	return answerOf(async () => {
		const answer = await dispatchRqo(
			{
				action: 'delete',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					model: 'section',
					tipo: REGISTRY,
					section_tipo: REGISTRY,
					action: 'delete',
					delete_mode: 'delete_record',
				},
				sqo: {
					section_tipo: [REGISTRY],
					limit: 0,
					offset: 0,
					filter_by_locators: rowIds.map((id) => ({
						section_tipo: REGISTRY,
						section_id: String(id),
					})),
				},
			} as unknown as Rqo,
			contextFor(principal),
		);
		await clearOntologyDerivedCaches();
		return answer;
	});
}

/** A function + trigger exist (the fault injections create them INSIDE a rolled-back transaction). */
async function faultObjects(): Promise<{ triggers: number; functions: number }> {
	const triggers = (await sql.unsafe(
		"SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'zzrs\\_fault%'",
	)) as { n: number }[];
	const functions = (await sql.unsafe(
		"SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'zzrs\\_fault%'",
	)) as { n: number }[];
	return { triggers: triggers[0]?.n ?? -1, functions: functions[0]?.n ?? -1 };
}

/** A BEFORE `event` trigger on `table` raising 'zzrs injected fault' when `condition` holds. */
async function injectFault(
	name: string,
	table: string,
	event: string,
	condition: string,
): Promise<void> {
	await sql.unsafe(
		`CREATE FUNCTION zzrs_fault_${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
		 BEGIN IF ${condition} THEN RAISE EXCEPTION 'zzrs injected fault (${name})'; END IF; RETURN NEW; END
		 $fn$`,
		[],
	);
	await sql.unsafe(
		`CREATE TRIGGER zzrs_fault_${name}_trg BEFORE ${event} ON "${table}"
		 FOR EACH ROW EXECUTE FUNCTION zzrs_fault_${name}()`,
		[],
	);
}

// --- sweep -----------------------------------------------------------------------

async function sweepTld(tld: string): Promise<void> {
	if (!SCRATCH_TLD.test(tld)) throw new Error(`sweep refused a non-scratch tld '${tld}'`);
	await snapshot(tld); // records the ontology35 ids still present
	await deleteOntologyByTld(tld, (st, sid) => deleteSectionRecord(st, sid, ROOT));
	await deleteTldNodes(tld);
	await sql.unsafe(`DELETE FROM "${NODE_TABLE}" WHERE section_tipo = $1`, [`${tld}0`]);
	await sql.unsafe(
		`DELETE FROM "${ONTOLOGY_MAIN_TABLE}" WHERE section_tipo = $1 AND string @> $2::text::jsonb`,
		[ONTOLOGY_MAIN, encodeForJsonb({ hierarchy6: [{ value: tld }] })],
	);
	for (const suffix of ['1', '2']) {
		const sectionTipo = `${tld}${suffix}`;
		await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [sectionTipo]);
	}
	await sql.unsafe(
		"DELETE FROM matrix_time_machine WHERE section_tipo = ANY(string_to_array($1, ','))",
		[`${tld}0,${tld}1,${tld}2`],
	);
	await sql.unsafe("DELETE FROM matrix_counter WHERE tipo = ANY(string_to_array($1, ','))", [
		`${tld}0,${tld}1,${tld}2`,
	]);
}

/** Drop the dd774 grants provisioning added for `zzrs*` sections to a profile. */
async function sweepProfileGrants(): Promise<void> {
	await sql.unsafe(
		`UPDATE matrix_profiles
		    SET misc = jsonb_set(misc, '{dd774}', COALESCE((
		          SELECT jsonb_agg(entry) FROM jsonb_array_elements(misc->'dd774') entry
		           WHERE NOT (entry->>'section_tipo' ~ '^zzrs[a-z]+[0-9]+$')), '[]'::jsonb))
		  WHERE section_tipo = 'dd234'
		    AND jsonb_typeof(misc->'dd774') = 'array'
		    AND EXISTS (SELECT 1 FROM jsonb_array_elements(misc->'dd774') entry
		                 WHERE entry->>'section_tipo' ~ '^zzrs[a-z]+[0-9]+$')`,
	);
}

async function sweepAll(): Promise<void> {
	await assertTestDatabase('hierarchy_rebuild_scope_native: sweep');
	for (const tld of SCRATCH_TLDS) await sweepTld(tld);
	// Registry rows: this run's, plus any a killed run left (attributable by the tld).
	const leftovers = (await sql.unsafe(
		`SELECT section_id FROM "${REGISTRY_TABLE}" WHERE section_tipo = $1
		   AND (lower(string->'hierarchy6'->0->>'value') ~ '^zzrs[a-z]+$'
		        OR string->'hierarchy5'->0->>'value' LIKE 'zzrs rebuild scope %')`,
		[REGISTRY],
	)) as { section_id: number }[];
	const rowIds = new Set([...registryRows, ...leftovers.map((row) => Number(row.section_id))]);
	for (const rowId of rowIds) {
		await sql.unsafe(
			`DELETE FROM "${REGISTRY_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[REGISTRY, rowId],
		);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[REGISTRY, rowId],
		);
	}
	for (const mainId of mainIdsSeen) {
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[ONTOLOGY_MAIN, mainId],
		);
	}
	await sweepProfileGrants();
	// The fault injections live inside rolled-back transactions; a REGRESSED rollback
	// would commit them — never leave a raising trigger on a shared table.
	for (const [name, table] of [
		['provision', NODE_TABLE],
		['grant', 'matrix_profiles'],
	] as const) {
		await sql.unsafe(`DROP TRIGGER IF EXISTS zzrs_fault_${name}_trg ON "${table}"`, []);
		await sql.unsafe(`DROP FUNCTION IF EXISTS zzrs_fault_${name}()`, []);
	}
	await dropSituation(FOREIGN);
	clearPrincipalCache();
	clearPermissionsCache();
	invalidateAllToolCaches();
	await clearOntologyDerivedCaches();
}

// --- situation -------------------------------------------------------------------

beforeAll(async () => {
	await assertTestDatabase('hierarchy_rebuild_scope_native');
	await sweepAll(); // a killed prior run must not poison this one
	await ensureSituation(FOREIGN);
	await sb.install([
		[REGISTRY, REGISTRY],
		[REGISTRY, 'hierarchy6'],
	]);
	root = await resolvePrincipal(ROOT);
	attacker = await resolvePrincipal(sb.userA);
});

afterAll(async () => {
	// Measured BEFORE the sweep (which drops them): a fault trigger still present
	// here means a rolled-back transaction COMMITTED — recorded, swept anyway, then failed.
	const faultsBeforeSweep = await faultObjects();
	try {
		await sweepAll();
	} finally {
		await sb.release();
	}
	expect(faultsBeforeSweep).toEqual({ triggers: 0, functions: 0 });
	const residue = (await sql.unsafe(
		"SELECT DISTINCT tld FROM dd_ontology WHERE tld LIKE 'zzrs%'",
	)) as unknown[];
	expect(residue).toEqual([]);
});

// --- the gates ---------------------------------------------------------------------

describe('HIER-REBUILD door A (tool_hierarchy force_to_create) — teardown scope', () => {
	test('G1 hijack: a non-admin repoints its own row at an installed package — force rebuild is refused, the package intact', async () => {
		// The attacker's OWN, legitimately provisioned hierarchy.
		const attackerRow = await createRegistryRow(TLD.attacker);
		await provision(attackerRow);
		// The victim: an installed ontology package with NO registry row (5 nodes).
		await buildPackage(TLD.victim, [
			{ id: 1, parent: `${TLD.victim}0`, model: 'section' },
			{ id: 2, parent: `${TLD.victim}1`, model: 'section_group' },
			{ id: 3, parent: `${TLD.victim}2`, model: 'component_input_text' },
			{ id: 4, parent: `${TLD.victim}2`, model: 'component_input_text' },
			{ id: 5, parent: `${TLD.victim}1`, model: 'section_list' },
		]);

		// Preconditions: the persona is NOT an admin, holds level 2 on hierarchy1
		// (and hierarchy6), and the tool gate admits it on its own row.
		expect(attacker.isGlobalAdmin).toBe(false);
		expect(await getPermissions(attacker, REGISTRY, 'hierarchy6')).toBe(2);
		const loaded = await getLoadedTool('tool_hierarchy');
		const spec =
			loaded === undefined ? null : resolveAction(loaded.module, 'generate_virtual_section');
		expect(spec).not.toBeNull();
		expect(
			await assertActionPermission(
				spec as never,
				{ section_tipo: REGISTRY, section_id: attackerRow },
				attacker,
			),
		).toEqual({ ok: true });

		// The hijack's write, through the REAL save door.
		const saved = await saveTld(attacker, attackerRow, TLD.victim.toUpperCase());
		expect({ ok: saved.ok, code: saved.code }).toEqual({ ok: true, code: null });
		expect(await registryLiteral(attackerRow, 'hierarchy6')).toEqual([
			{ id: 1, lang: 'lg-nolan', value: TLD.victim.toUpperCase() },
		]);
		const before = await snapshot(TLD.victim);
		expect(before.nodes.length).toBe(6); // root + 5
		expect(before.records.length).toBe(5);
		expect(before.main.length).toBe(1);

		const answer = await generate(attacker, attackerRow, true);
		const after = await snapshot(TLD.victim);
		expect({ answerOk: answer.ok, victimIntact: after }).toEqual({
			answerOk: false,
			victimIntact: before,
		});
		expectRefusal(answer, ['root_only', 'ontology_package']);
	});

	test('G2 honest package rebuild: a sole-owner row over a package-shaped tld is refused ontology_package, untouched', async () => {
		// tch-shape: <tld>1/<tld>2 are virtuals of a section INSIDE the tld, which carries a subtree.
		await buildPackage(TLD.package, [
			{ id: 3, parent: `${TLD.package}0`, model: 'section' },
			{ id: 1, parent: `${TLD.package}0`, model: 'section', relations: [`${TLD.package}3`] },
			{ id: 2, parent: `${TLD.package}0`, model: 'section', relations: [`${TLD.package}3`] },
			{ id: 4, parent: `${TLD.package}3`, model: 'section_group' },
			{ id: 5, parent: `${TLD.package}4`, model: 'component_input_text' },
		]);
		const row = await createRegistryRow(TLD.package, {
			terms: `${TLD.package}1`,
			model: `${TLD.package}2`,
		});
		const before = await snapshot(TLD.package);
		expect(before.nodes.length).toBe(6);
		const rowBefore = await registryRowText(row);

		const answer = await generate(root, row, true);
		expect({
			answerOk: answer.ok,
			package: await snapshot(TLD.package),
			row: await registryRowText(row),
		}).toEqual({ answerOk: false, package: before, row: rowBefore });
		expectRefusal(answer, ['ontology_package']);
	});

	test('G2a legacy thesaurus (extra children) — WITHOUT force byte-identical; WITH force from scratch, terms intact (D10 pin)', async () => {
		const row = await createRegistryRow(TLD.legacy);
		await provision(row);
		// v4/v5 legacy extras: an own section_list + an empty exclude_elements
		// under <tld>1, and a child of another model under <tld>2.
		await addNode(TLD.legacy, { id: 3, parent: `${TLD.legacy}1`, model: 'section_list' });
		await addNode(TLD.legacy, { id: 4, parent: `${TLD.legacy}1`, model: 'exclude_elements' });
		await addNode(TLD.legacy, { id: 5, parent: `${TLD.legacy}2`, model: 'component_input_text' });
		await clearOntologyDerivedCaches();
		await addTerm(`${TLD.legacy}1`, 900, 'zzrs legacy term');
		const termsBefore = await terms(`${TLD.legacy}1`);
		expect(termsBefore.length).toBe(2); // the minted root + one term
		const rootBefore = await generalTermLocator(row);
		expect(rootBefore?.section_tipo).toBe(`${TLD.legacy}1`);

		// WITHOUT force: ensure — nothing deleted, nothing rewritten.
		const before = await snapshot(TLD.legacy);
		expect(before.nodes.length).toBe(6);
		const ensured = await generate(root, row, false);
		expect(ensured.ok).toBe(true);
		expect(await snapshot(TLD.legacy)).toEqual(before);

		// WITH force: from scratch — exactly <tld>0/1/2, records 1+2, a FRESH ontology35 row.
		const oldMain = await mainIds(TLD.legacy);
		expect(oldMain.length).toBe(1);
		const forced = await generate(root, row, true);
		expect(forced.ok).toBe(true);
		expect(await nodeTipos(TLD.legacy)).toEqual([
			`${TLD.legacy}0`,
			`${TLD.legacy}1`,
			`${TLD.legacy}2`,
		]);
		expect(await nodeRecordIds(TLD.legacy)).toEqual([1, 2]);
		const newMain = await mainIds(TLD.legacy);
		expect(newMain.length).toBe(1);
		expect(newMain[0]).not.toBe(oldMain[0]);
		expect(await terms(`${TLD.legacy}1`)).toEqual(termsBefore);
		const rootAfter = await generalTermLocator(row);
		expect({ tipo: rootAfter?.section_tipo, id: Number(rootAfter?.section_id) }).toEqual({
			tipo: `${TLD.legacy}1`,
			id: Number(rootBefore?.section_id),
		});
	});

	test('G2b case 2 (root-only), shape 1: hierarchy53 → a foreign defined section, no own <tld>0 — force refused root_only, nothing written', async () => {
		const row = await createRegistryRow(TLD.rootOnly, { terms: 'zzrsx1', model: 'zzrsx4' });
		const before = await snapshot(TLD.rootOnly);
		expect(before).toEqual({ nodes: [], records: [], main: [] });
		const rowBefore = await registryRowText(row);
		const foreignBefore = await recordCount('zzrsx1');

		const answer = await generate(root, row, true);
		expect({
			answerOk: answer.ok,
			tld: await snapshot(TLD.rootOnly),
			row: await registryRowText(row),
			foreignRecords: await recordCount('zzrsx1'),
		}).toEqual({ answerOk: false, tld: before, row: rowBefore, foreignRecords: foreignBefore });
		expectRefusal(answer, ['root_only']);
	});

	test('G2b case 2 (root-only), shape 2: <tld>1 is a REAL section (≤3 nodes) — force refused root_only, nothing torn down', async () => {
		await buildPackage(TLD.realOne, [{ id: 1, parent: `${TLD.realOne}0`, model: 'section' }]);
		const row = await createRegistryRow(TLD.realOne, { terms: `${TLD.realOne}1` });
		const before = await snapshot(TLD.realOne);
		expect(before.nodes.length).toBe(2); // <tld>0 + the real <tld>1
		expect(before.main.length).toBe(1);
		const rowBefore = await registryRowText(row);

		const answer = await generate(root, row, true);
		expect({
			answerOk: answer.ok,
			tld: await snapshot(TLD.realOne),
			row: await registryRowText(row),
		}).toEqual({ answerOk: false, tld: before, row: rowBefore });
		expectRefusal(answer, ['root_only']);
	});

	test('G2c ensure (no force) on a case 2 row never provisions <tld>0/1/2 — the root resolves in the declared section', async () => {
		const row = await createRegistryRow(TLD.ensureCase2, { terms: 'zzrsx2', model: 'zzrsx3' });
		expect(await snapshot(TLD.ensureCase2)).toEqual({ nodes: [], records: [], main: [] });

		await generate(root, row, false);
		const after = await snapshot(TLD.ensureCase2);
		const generalTerm = await generalTermLocator(row);
		expect({
			nodes: after.nodes.length,
			records: after.records.length,
			main: after.main.length,
			terms: await registryLiteral(row, 'hierarchy53'),
			rootSection: generalTerm?.section_tipo ?? null,
		}).toEqual({
			nodes: 0,
			records: 0,
			main: 0,
			terms: [{ id: 1, lang: 'lg-nolan', value: 'zzrsx2' }],
			rootSection: 'zzrsx2',
		});
	});

	test('G3 duplicate declaration: two registry rows declare the tld — force refused not_sole_declarer, untouched', async () => {
		const owner = await createRegistryRow(TLD.duplicate);
		await provision(owner);
		const twin = await createRegistryRow(TLD.duplicate);
		const before = await snapshot(TLD.duplicate);
		expect(before.nodes.length).toBe(3);
		expect(before.records.length).toBe(2);
		const rowsBefore = [await registryRowText(owner), await registryRowText(twin)];

		const answer = await generate(root, owner, true);
		expect({
			answerOk: answer.ok,
			tld: await snapshot(TLD.duplicate),
			rows: [await registryRowText(owner), await registryRowText(twin)],
		}).toEqual({ answerOk: false, tld: before, rows: rowsBefore });
		expectRefusal(answer, ['not_sole_declarer']);
	});

	test('G4 control: an owned case 1 hierarchy force-rebuilds, its terms survive', async () => {
		const row = await createRegistryRow(TLD.control);
		await provision(row);
		await addTerm(`${TLD.control}1`, 900, 'zzrs control term');
		const termsBefore = await terms(`${TLD.control}1`);
		expect(termsBefore.length).toBe(2);
		// The rebuilt-from-scratch probe: the dd_ontology serial ids and the ontology35
		// row id (record dates have one-second resolution — not a probe).
		const before = await snapshot(TLD.control);

		const started = performance.now();
		const answer = await generate(root, row, true);
		const elapsedMs = performance.now() - started;
		expect({ ok: answer.ok, code: answer.code }).toEqual({ ok: true, code: null });
		expect(await nodeTipos(TLD.control)).toEqual([
			`${TLD.control}0`,
			`${TLD.control}1`,
			`${TLD.control}2`,
		]);
		expect(await nodeRecordIds(TLD.control)).toEqual([1, 2]);
		// rebuilt: the nodes and the ontology35 row were re-created (from scratch), not kept.
		const after = await snapshot(TLD.control);
		expect(after.main.length).toBe(1);
		expect(after.nodes).not.toEqual(before.nodes);
		expect(after.main).not.toEqual(before.main);
		expect(await terms(`${TLD.control}1`)).toEqual(termsBefore);
		const generalTerm = await generalTermLocator(row);
		expect(generalTerm?.section_tipo).toBe(`${TLD.control}1`);
		// Plan §8: the predicate is a handful of indexed queries — a rebuild stays an operator-scale action.
		expect(elapsedMs).toBeLessThan(30_000);
	});

	test('G7 invalid source: hierarchy109 names a non-section — refused invalid_source BEFORE any delete, <tld>0/1/2 intact', async () => {
		const row = await createRegistryRow(TLD.invalid);
		await provision(row);
		// The known master defect shape (`hiearachy20`): the source no longer names a section.
		await sql.unsafe(
			`UPDATE "${REGISTRY_TABLE}" SET string = jsonb_set(string, '{hierarchy109}', $3::text::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[REGISTRY, row, encodeForJsonb([{ id: 1, lang: 'lg-nolan', value: NOT_A_SECTION }])],
		);
		const before = await snapshot(TLD.invalid);
		expect(before.nodes.length).toBe(3);
		expect(before.records.length).toBe(2);
		expect(before.main.length).toBe(1);

		const answer = await generate(root, row, true);
		expect({ answerOk: answer.ok, tld: await snapshot(TLD.invalid) }).toEqual({
			answerOk: false,
			tld: before,
		});
		expectRefusal(answer, ['invalid_source']);
	});

	test('G7b fault injection: provisioning fails AFTER the teardown — the one transaction rolls the teardown back, nothing changed', async () => {
		const row = await createRegistryRow(TLD.fault);
		await provision(row);
		const before = await snapshot(TLD.fault);
		expect(before.nodes.length).toBe(3);
		expect(before.records.length).toBe(2);
		expect(before.main.length).toBe(1);
		const rowBefore = await registryRowText(row);

		// The seam is rebuild's OWN injected deleteRecord (no engine hook): the first
		// teardown delete also strips the row's typology (hierarchy9) — a precondition
		// the re-provisioning then fails on, AFTER the teardown has run.
		let sabotaged = false;
		const outcome = await rebuildHierarchy(row, ROOT, async (sectionTipo, sectionId) => {
			const deleted = await deleteSectionRecord(sectionTipo, sectionId, ROOT);
			if (!sabotaged) {
				sabotaged = true;
				await sql.unsafe(
					`UPDATE "${REGISTRY_TABLE}" SET relation = relation - 'hierarchy9'
					  WHERE section_tipo = $1 AND section_id = $2`,
					[REGISTRY, row],
				);
			}
			return deleted;
		});
		await clearOntologyDerivedCaches();
		expect(sabotaged).toBe(true);
		expect({
			ok: outcome.ok,
			tld: await snapshot(TLD.fault),
			row: await registryRowText(row),
		}).toEqual({ ok: false, tld: before, row: rowBefore });
	});

	test('G8a half-projected package (mdcat shape): <tld>0 records with no nodes + an ontology35 row, claimed by a fresh row — refused ontology_package, nothing changed', async () => {
		const tld = TLD.halfProjected;
		await ensureMainSection(
			{ tld, typology_id: 2, name_data: [{ id: 1, lang: 'lg-eng', value: `zzrs package ${tld}` }] },
			ROOT,
		);
		await createDdOntologyRootNode({ tld }, ROOT);
		for (const id of [1, 2, 3]) {
			await addNodeRecord(tld, { id, parent: `${tld}0`, model: 'section' });
		}
		await clearOntologyDerivedCaches();
		const row = await createRegistryRow(tld);
		const before = await snapshot(tld);
		expect({
			nodes: before.nodes.length,
			records: before.records.length,
			main: before.main.length,
		}).toEqual({
			nodes: 1,
			records: 3,
			main: 1,
		});
		const rowBefore = await registryRowText(row);

		const answer = await generate(root, row, true);
		expect({
			answerOk: answer.ok,
			tld: await snapshot(tld),
			row: await registryRowText(row),
		}).toEqual({
			answerOk: false,
			tld: before,
			row: rowBefore,
		});
		expectRefusal(answer, ['ontology_package']);
		// An orphan / package tld keeps the ontology-update advice.
		expect((await classifyHierarchyRebuild(row)).detail).toContain(
			'repair it with an ontology update',
		);
	});

	test('G8b inactive package: an ontology35 row and the <tld>0 root only (absent shape, no records) — refused ontology_package, nothing changed', async () => {
		const tld = TLD.mainOnly;
		await buildPackage(tld, []);
		const row = await createRegistryRow(tld);
		const before = await snapshot(tld);
		expect({
			nodes: before.nodes.length,
			records: before.records.length,
			main: before.main.length,
		}).toEqual({
			nodes: 1,
			records: 0,
			main: 1,
		});

		const answer = await generate(root, row, true);
		expect({ answerOk: answer.ok, tld: await snapshot(tld) }).toEqual({
			answerOk: false,
			tld: before,
		});
		expectRefusal(answer, ['ontology_package']);
	});

	test('G8c projection inconsistent: a provisioned tld with a node whose <tld>0 record is gone — refused ontology_package', async () => {
		const tld = TLD.sourcelessNode;
		const row = await createRegistryRow(tld);
		await provision(row);
		await addNode(tld, { id: 3, parent: `${tld}1`, model: 'section_list' });
		await sql.unsafe(`DELETE FROM "${NODE_TABLE}" WHERE section_tipo = $1 AND section_id = 3`, [
			`${tld}0`,
		]);
		await clearOntologyDerivedCaches();
		const before = await snapshot(tld);
		expect({ nodes: before.nodes.length, records: before.records.length }).toEqual({
			nodes: 4,
			records: 2,
		});

		const answer = await generate(root, row, true);
		expect({ answerOk: answer.ok, tld: await snapshot(tld) }).toEqual({
			answerOk: false,
			tld: before,
		});
		expectRefusal(answer, ['ontology_package']);
		// An OWNED hierarchy's drift: re-project from its own records — never "an ontology update".
		// (The detail rides the operator-disclosed refusal; read it from the predicate.)
		const { detail } = await classifyHierarchyRebuild(row);
		expect({
			ownRepair: detail.includes(`re-project '${tld}' from its records`),
			updateAdvice: detail.includes('ontology update'),
		}).toEqual({ ownRepair: true, updateAdvice: false });
	});

	test('G8d projection inconsistent: a provisioned tld with an extra <tld>0 record never projected — refused ontology_package', async () => {
		const tld = TLD.unprojectedRecord;
		const row = await createRegistryRow(tld);
		await provision(row);
		await addNodeRecord(tld, { id: 3, parent: `${tld}1`, model: 'section_list' });
		await clearOntologyDerivedCaches();
		const before = await snapshot(tld);
		expect({ nodes: before.nodes.length, records: before.records.length }).toEqual({
			nodes: 3,
			records: 3,
		});

		const answer = await generate(root, row, true);
		expect({ answerOk: answer.ok, tld: await snapshot(tld) }).toEqual({
			answerOk: false,
			tld: before,
		});
		expectRefusal(answer, ['ontology_package']);
	});

	test('G9 stray node: valid virtuals + an extra sibling section under <tld>0 — refused ontology_package (no model allowlist: WHERE it hangs decides)', async () => {
		const tld = TLD.straySibling;
		const row = await createRegistryRow(tld);
		await provision(row);
		await addNode(tld, { id: 3, parent: `${tld}0`, model: 'section' });
		await clearOntologyDerivedCaches();
		const before = await snapshot(tld);
		expect(before.nodes.length).toBe(4);

		const answer = await generate(root, row, true);
		expect({ answerOk: answer.ok, tld: await snapshot(tld) }).toEqual({
			answerOk: false,
			tld: before,
		});
		expectRefusal(answer, ['ontology_package']);
	});

	test('G10 SQL fault mid-teardown: a real Postgres error rolls everything back — ok:false (never a throw), the error named, nothing changed', async () => {
		const tld = TLD.sqlFault;
		const row = await createRegistryRow(tld);
		await provision(row);
		const before = await snapshot(tld);
		const rowBefore = await registryRowText(row);

		let faulted = false;
		const outcome = await rebuildHierarchy(row, ROOT, async (sectionTipo, sectionId) => {
			const deleted = await deleteSectionRecord(sectionTipo, sectionId, ROOT);
			if (!faulted) {
				faulted = true;
				await sql.unsafe('SELECT 1 / 0', []);
			}
			return deleted;
		});
		await clearOntologyDerivedCaches();
		expect(faulted).toBe(true);
		expect({
			ok: outcome.ok,
			named: outcome.errors.join(' ').includes('division by zero'),
			usable: outcome.state.usable,
			tld: await snapshot(tld),
			row: await registryRowText(row),
		}).toEqual({ ok: false, named: true, usable: true, tld: before, row: rowBefore });
	});

	test('G11 SQL fault INSIDE provisioning (trigger on <tld>0/2): the provisioning savepoint keeps the rebuild transaction usable — ok:false naming the fault, nothing changed, trigger gone', async () => {
		const tld = TLD.provisionFault;
		const row = await createRegistryRow(tld);
		await provision(row);
		const before = await snapshot(tld);
		const rowBefore = await registryRowText(row);

		let injected = false;
		const outcome = await rebuildHierarchy(row, ROOT, async (sectionTipo, sectionId) => {
			if (!injected) {
				injected = true;
				// Transactional DDL: created inside the rebuild's transaction, gone with its rollback.
				await injectFault(
					'provision',
					NODE_TABLE,
					'INSERT',
					`NEW.section_tipo = '${tld}0' AND NEW.section_id = 2`,
				);
			}
			return deleteSectionRecord(sectionTipo, sectionId, ROOT);
		});
		await clearOntologyDerivedCaches();
		const errors = outcome.errors.join(' ');
		expect({
			ok: outcome.ok,
			namesFault: errors.includes('zzrs injected fault (provision)'),
			aborted: /current transaction is aborted/i.test(errors),
			tld: await snapshot(tld),
			row: await registryRowText(row),
			faultObjects: await faultObjects(),
		}).toEqual({
			ok: false,
			namesFault: true,
			aborted: false,
			tld: before,
			row: rowBefore,
			faultObjects: { triggers: 0, functions: 0 },
		});
	});

	test('G12 SQL fault in the NON-FATAL permission grant: its savepoint keeps provisioning going — the hierarchy ends usable, the grant absent', async () => {
		const tld = TLD.grantFault;
		let outcome: Awaited<ReturnType<typeof ensureHierarchy>> | null = null;
		let granted = -1;
		await rolledBack(async () => {
			const row = await createRegistryRow(tld);
			await injectFault('grant', 'matrix_profiles', 'UPDATE', 'true');
			outcome = await ensureHierarchy(row, ROOT);
			const rows = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_profiles, jsonb_array_elements(misc->'dd774') entry
				  WHERE section_tipo = 'dd234' AND jsonb_typeof(misc->'dd774') = 'array'
				    AND entry->>'section_tipo' = ANY(string_to_array($1, ','))`,
				[`${tld}1,${tld}2`],
			)) as { n: number }[];
			granted = rows[0]?.n ?? -1;
		});
		const result = outcome as unknown as { ok: boolean; errors: string[] } | null;
		expect({
			ok: result?.ok,
			errors: result?.errors,
			granted,
			faultObjects: await faultObjects(),
		}).toEqual({
			ok: true,
			errors: [],
			granted: 0,
			faultObjects: { triggers: 0, functions: 0 },
		});
		expect(await nodeTipos(tld)).toEqual([]);
	});

	test('G13 inspect_hierarchy serves rebuild {allowed, reason}: allowed for the sole owner, not_sole_declarer once a twin declares the tld', async () => {
		const tld = TLD.inspect;
		const row = await createRegistryRow(tld);
		await provision(row);
		expect(await inspectThroughTool(root, row)).toEqual({
			ok: true,
			rebuild: { allowed: true, reason: null },
		});
		await createRegistryRow(tld);
		expect(await inspectThroughTool(root, row)).toEqual({
			ok: true,
			rebuild: { allowed: false, reason: 'not_sole_declarer' },
		});
	});
});

describe('HIER-REBUILD door B (dd_core_api delete of a registry row, global admin)', () => {
	test('G6 duplicate: deleting one of two rows declaring the tld is refused not_sole_declarer — no cascade, no record delete', async () => {
		const owner = await createRegistryRow(TLD.doorB);
		await provision(owner);
		const twin = await createRegistryRow(TLD.doorB);
		const before = await snapshot(TLD.doorB);
		expect(before.nodes.length).toBe(3);
		expect(root.isGlobalAdmin).toBe(true);
		const rowsBefore = [await registryRowText(owner), await registryRowText(twin)];

		const answer = await deleteRegistryRow(root, twin);
		expect({
			answerOk: answer.ok,
			tld: await snapshot(TLD.doorB),
			rows: [await registryRowText(owner), await registryRowText(twin)],
		}).toEqual({ answerOk: false, tld: before, rows: rowsBefore });
		expectRefusal(answer, ['not_sole_declarer']);
	});

	test('G6b multi-delete: two targets, the second refused — the whole delete refuses BEFORE the first cascade (nothing torn down, no row deleted)', async () => {
		// A: an owned, provisioned hierarchy (sole declarer) at the LOWER id — first in the target list.
		const owned = await createRegistryRow(TLD.multiOwned);
		await provision(owned);
		// B: one of two rows declaring another tld — its cascade is refused not_sole_declarer.
		const shared = await createRegistryRow(TLD.multiShared);
		const sharedTwin = await createRegistryRow(TLD.multiShared);
		expect(owned).toBeLessThan(shared);
		const before = await snapshot(TLD.multiOwned);
		expect(before.nodes.length).toBe(3);
		const rowsBefore = [owned, shared, sharedTwin].map((id) => registryRowText(id));
		const rowsBeforeText = await Promise.all(rowsBefore);

		const answer = await deleteRegistryRows(root, [owned, shared]);
		expect({
			answerOk: answer.ok,
			ownedTld: await snapshot(TLD.multiOwned),
			rows: await Promise.all([owned, shared, sharedTwin].map((id) => registryRowText(id))),
		}).toEqual({ answerOk: false, ownedTld: before, rows: rowsBeforeText });
		expectRefusal(answer, ['not_sole_declarer']);
	});
});

/**
 * CORE cases — armed with the fix. Each runs inside a transaction that is
 * ALWAYS rolled back (the registry row is created INSIDE it, so a killed run
 * leaves nothing), and asks the PURE predicate before any door: a predicate
 * that does not answer `core` fails the test WITHOUT calling the door. The
 * rollback is the only guard once a door runs (the throwing deleteRecord is
 * reached only after retractOntology has already purged the nodes).
 */
const ROLLBACK = new Error('hierarchy_rebuild_scope_native: always roll back');
const CORE_TLDS = ['rsc', 'lg', 'test'] as const;

/** Run `work` in a transaction that is always rolled back; rethrows anything else. */
async function rolledBack(work: () => Promise<void>): Promise<void> {
	try {
		await withTransaction(async () => {
			await work();
			throw ROLLBACK;
		});
	} catch (error) {
		if (error !== ROLLBACK) throw error;
	} finally {
		await clearOntologyDerivedCaches();
	}
}

describe.skipIf(!CORE_CASES_ARMED)(
	'HIER-REBUILD core TLDs (G5, G6 core) — inside an always-rolled-back transaction, predicate first',
	() => {
		for (const coreTld of CORE_TLDS) {
			test(`G5 core: force rebuild of a row declaring '${coreTld}' is refused core, '${coreTld}' untouched`, async () => {
				const countBefore = (await nodeTipos(coreTld)).length;
				expect(countBefore).toBeGreaterThan(0);
				let refusal: Answer | null = null;
				let countInside = -1;
				await rolledBack(async () => {
					const row = await createRegistryRow(coreTld);
					// Precondition: the pure classifier refuses `core` — else no door call.
					const verdict = await classifyHierarchyRebuild(row);
					if (verdict.reason !== 'core') {
						throw new Error(
							`precondition: classifyHierarchyRebuild answered ${verdict.reason} for '${coreTld}' — the door is NOT called`,
						);
					}
					refusal = await answerOf(async () => {
						const outcome = await rebuildHierarchy(row, ROOT, () => {
							throw new Error(`deleteRecord reached for core tld '${coreTld}'`);
						});
						return { status: 200, body: { ok: outcome.ok } };
					});
					countInside = (await nodeTipos(coreTld)).length;
				});
				expect(countInside).toBe(countBefore);
				expect((await nodeTipos(coreTld)).length).toBe(countBefore);
				expectRefusal(refusal as unknown as Answer, ['core']);
			});

			test(`G6 core: door B delete of a row declaring '${coreTld}' is refused core — no cascade, row kept`, async () => {
				const countBefore = (await nodeTipos(coreTld)).length;
				let answer: Answer | null = null;
				let countInside = -1;
				let rowKept = false;
				await rolledBack(async () => {
					const row = await createRegistryRow(coreTld);
					const rowBefore = await registryRowText(row);
					// Precondition: the cascade check refuses `core` — else no door call.
					const check = await answerOf(async () => {
						await assertRegistryCascadeAllowed(REGISTRY, row);
						return { status: 200, body: { ok: true } };
					});
					if (check.code !== REFUSAL_CODE || check.reason !== 'core') {
						throw new Error(
							`precondition: assertRegistryCascadeAllowed answered ${check.code}/${String(check.reason)} for '${coreTld}' — the door is NOT called`,
						);
					}
					answer = await deleteRegistryRow(root, row);
					countInside = (await nodeTipos(coreTld)).length;
					rowKept = (await registryRowText(row)) === rowBefore;
				});
				expect(countInside).toBe(countBefore);
				expect(rowKept).toBe(true);
				expectRefusal(answer as unknown as Answer, ['core']);
			});
		}
	},
);
