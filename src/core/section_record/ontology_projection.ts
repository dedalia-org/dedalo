/**
 * ONTOLOGY NODE PROJECTION — the ONE per-record door into dd_ontology, and the
 * record-lifecycle hook that keeps a node moving with its source record.
 *
 * THE INVARIANT (ONT-1/2/3, audit 2026-09-26): `dd_ontology(tld)` equals the
 * parse of `matrix_ontology(<tld>0)` (+ its `<tld>0` root) for every tld that
 * holds a projection, and a torn-down tld holds none. ("Active" = holds rows,
 * getActiveTlds; nothing keys it on hierarchy4 yet — ontology_state
 * syncOntologyActivation.) The doors that write a tld's NODES from its source:
 *   - whole tld — `ontology/ontology_state.ts` rebuildOntology /
 *     retractOntology / syncOntologyActivation;
 *   - one record — `projectOntologyNode` / `unprojectOntologyNode` below;
 *   - record lifecycle — `projectOntologyRecordLifecycle` below, called inside
 *     the record's own transaction by `deleteSectionRecord`,
 *     `deleteSectionData` (section/record/delete_record.ts) and the birth
 *     chokepoint `writeBirth` (record_write.ts).
 * And the dd_ontology writers that are NOT a projection of a matrix record —
 * named so nobody reads the list above as exhaustive:
 *   - roots and groupers — `ontology/ontology_write.ts` createDdOntologyRootNode
 *     (`<tld>0`, no source record) and createParentGrouper (on the 'ensure'
 *     path: the grouper tld's registry row via ensureMainSection, the
 *     `ontology0` parent node, the `ontologytype0/<N>` matrix record and its
 *     `ontologytype<N>` node). The 'existing' path (the ontology update, the
 *     activation) builds none of them: the root names its grouper only;
 *   - the archive restore — `archive/restore.ts` upserts the archive's
 *     dd_ontology rows DIRECTLY (an archive carries no matrix_ontology source),
 *     so it writes only a tld that is the ARCHIVE'S OWN: under each written
 *     tld's projection lock (lockOntologyProjection) it REFUSES a tld that holds
 *     source records here — never an orphan or a clobbered node in a sourced
 *     tld. Residual, ledgered open: the archive's own tld still holds rows with
 *     no source record (closure: source records in the archive format).
 *     Contract: restore.ts's header; gate:
 *     test/unit/archive_restore_projection_native.test.ts;
 *   - the seed / test fixtures (`test_data/`, the install seed).
 * Gates: test/unit/ontology_projection_guard_native.test.ts (the guard),
 * ontology_record_lifecycle_native.test.ts (the lifecycle),
 * ontology_derive_packages_native.test.ts + ontology_update_shell_native.test.ts
 * (the whole-tld doors). "ONE per-record door" is a census: only this module and
 * ontology_state.ts may PARSE an ontology record
 * (ontology_single_writer_tripwire rule 3).
 *
 * ADDRESSING RULE (INV-A). A governed record `<tld>0/<id>` projects the node
 * `<tld><id>` and nothing else: the tipo is `buildTipo(requiredOntologyTld(
 * sectionTipo), sectionId)` — derived from the record's ADDRESS, never read
 * from its data (`ontology7`) or from a snapshot. A record whose `ontology7`
 * parses into another namespace is REFUSED (`ontology.invalid_node`), so it can
 * never overwrite a canonical node of another tld — the `foreign` drift
 * ontology_state reports stays a report, not a write.
 *
 * CONCURRENCY. Every door here takes the tld's projection lock
 * (dd_ontology.ts lockOntologyProjection) inside its transaction BEFORE its
 * first read, exactly as the whole-tld re-derive does before its parse: a
 * rebuild and a delete / undelete of the same `<tld>0` record are ordered, so
 * node presence follows record presence. Gate:
 * test/unit/ontology_projection_race_native.test.ts.
 *
 * WHO MAY PROJECT CONTENT (developer-only, as the explicit door). Writing a
 * record's PARSE into the live dd_ontology is a developer act — tool_ontology
 * `set_records_in_dd_ontology` is declared `developer` and asserts it. The
 * lifecycle hook is reached by plain section grants (a TM undelete, a bulk
 * revert, an override delete), so a branch that would write CONTENT — a
 * governed birth, an override's re-parse on birth or death — runs only for a
 * DEVELOPER principal, and FAILS CLOSED otherwise: no principal (an event
 * outside any request scope — the stdio MCP surface, a script — or an
 * unauthenticated one) is NOT a developer. There is no implicit "system":
 * the system flows (the installer, the ontology update, the seed compiler)
 * never need these branches — they re-derive whole tlds through
 * ontology/ontology_state.ts rebuildOntology, which is not principal-gated.
 * Anyone else's event writes no content: the node stays as a developer last
 * projected it and inspectOntology reports the record as `missing` / `stale`
 * drift for tool_ontology to resolve. A governed DEATH is not content: the node
 * of a record that no longer exists is removed for every principal (owner
 * decision D3, PHP parity). Gate: ontology_record_lifecycle_native L11 (L11f:
 * no request scope / no principal).
 *
 * WHY HERE (section_record/, a leaf). The lifecycle hook is called from the
 * write chokepoint, so this module must not pull the provisioning graph
 * (ontology_write.ts → create_record → select_lang …) into it: it imports only
 * the dd_ontology layer, the transaction primitive, the request-context
 * accessor, the parser and the pure tld rules.
 */

import {
	type DdOntologyNode,
	deleteDdOntologyNode,
	lockOntologyProjection,
	readDdOntologyRow,
	upsertDdOntologyNode,
} from '../db/dd_ontology.ts';
import { withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { ONTOLOGY_OVERWRITE } from '../ontology/ontology_tipos.ts';
import { parseSectionRecordToOntologyNode } from '../ontology/parser.ts';
import { buildTipo, LOCAL_ONTOLOGY_SECTION, requiredOntologyTld } from '../ontology/tld.ts';
import { changedDeclaredOrderTipos, declaredOrderSignature } from '../relations/order_locators.ts';
import { currentPrincipal } from '../security/request_context.ts';

declare const addressBrand: unique symbol;

/**
 * A governed record's address and the ONE node tipo it may project. Only
 * `ontologyNodeAddress` mints it (the brand), so a tipo can never be handed in
 * from record data.
 */
export interface OntologyNodeAddress {
	readonly sectionTipo: string;
	readonly sectionId: number;
	readonly tld: string;
	readonly tipo: string;
	readonly [addressBrand]: true;
}

/**
 * The address of record `sectionTipo/sectionId`, or null when the section is
 * not an ontology node section (`localontology0`, `ontology35`, `ontology1..N`,
 * `test3`, … — see tld.ts requiredOntologyTld) or the id is not a positive
 * integer.
 */
export function ontologyNodeAddress(
	sectionTipo: string,
	sectionId: number | string,
): OntologyNodeAddress | null {
	const tld = requiredOntologyTld(sectionTipo);
	const id = positiveId(sectionId);
	if (tld === null || id === null) return null;
	return { sectionTipo, sectionId: id, tld, tipo: buildTipo(tld, id) } as OntologyNodeAddress;
}

/** The positive safe integer a section id names (a number, or a string of digits), or null. */
function positiveId(sectionId: number | string): number | null {
	const id =
		typeof sectionId === 'number'
			? sectionId
			: /^[0-9]+$/.test(sectionId)
				? Number(sectionId)
				: Number.NaN;
	return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

/**
 * The refusal of a record whose parse lands outside its own address (INV-A) — a thin
 * DedaloError family (ERRORS_SPEC §2.1) on `ontology.invalid_node`. The CLASS is the
 * discriminator: the doors that tolerate THIS refusal (a restore is never blocked by it, a
 * setRecords batch names it and goes on — projectTolerant below, ontology_write.ts
 * setRecordsInDdOntology) must not swallow a grammar or DB-constraint refusal of the same
 * code (dd_ontology.ts), which stays fatal. Gate: ontology_projection_guard_native G2f.
 */
export class ForeignOntologyNodeRefused extends DedaloError {
	/** The operator line a tolerating door reports (a composed sentence, never raw text). */
	readonly line: string;

	constructor(address: OntologyNodeAddress, node: DdOntologyNode) {
		const line = `${address.sectionTipo}/${address.sectionId} declares tld '${node.tld ?? ''}' (parses to '${node.tipo}'), not '${address.tld}' — nothing written`;
		super('ontology.invalid_node', {
			message: line,
			coordinates: {
				section_tipo: address.sectionTipo,
				section_id: address.sectionId,
				declared_tld: node.tld ?? '',
			},
		});
		this.name = 'ForeignOntologyNodeRefused';
		this.line = line;
	}
}

/**
 * Parse the record at `address` and upsert its node — only when the parse IS
 * that address's node. `tldless` = the record declares no tld (or is absent):
 * nothing written. A parse into another tld or tipo throws ForeignOntologyNodeRefused
 * BEFORE any write.
 */
export async function projectOntologyNode(
	address: OntologyNodeAddress,
): Promise<{ kind: 'projected'; tipo: string } | { kind: 'tldless' }> {
	// The parse and the upsert are one unit under the tld's projection lock (module
	// header, CONCURRENCY): joins the caller's transaction, or opens its own.
	return withTransaction(async () => {
		await lockOntologyProjection([address.tld]);
		const node = await parseSectionRecordToOntologyNode(address.sectionTipo, address.sectionId);
		if (node === null) return { kind: 'tldless' } as const;
		if (node.tld !== address.tld || node.tipo !== address.tipo) {
			throw new ForeignOntologyNodeRefused(address, node);
		}
		// The portal order model's ontology-change trigger: the node's declared portal order
		// BEFORE the upsert (read live, under the projection lock).
		const orderBefore = declaredOrderSignature((await readDdOntologyRow(node.tipo))?.properties);
		await upsertDdOntologyNode(node);
		await queueOrderReconcileOnChange(node.tipo, orderBefore, node.properties);
		return { kind: 'projected', tipo: node.tipo } as const;
	});
}

/**
 * THE ONTOLOGY-CHANGE TRIGGER of the portal order model, one-record half (
 * backfill; the whole-tld half is ontology_state.ts rebuildOntology): a local
 * `order` edit (tool_ontology, `localontology0`) that ADDED or CHANGED the
 * node's declared portal order re-sorts its hosts through the
 * `portal_declared_order` reconcile, POST-COMMIT. An unchanged declaration
 * queues nothing.
 */
async function queueOrderReconcileOnChange(
	tipo: string,
	before: string | null,
	afterProperties: unknown,
): Promise<void> {
	const changed = changedDeclaredOrderTipos(
		new Map([[tipo, before]]),
		new Map([[tipo, declaredOrderSignature(afterProperties)]]),
	);
	if (changed.length === 0) return;
	// CONVENTIONS §2 rationale 1 (cycle-breaking at the chokepoint seam): the reconcile
	// writes through save_component → record_write, whose birth lifecycle calls THIS
	// module (projectOntologyRecordLifecycle); a static edge would close that loop.
	const { queueDeclaredOrderReconcile } = await import('../relations/declared_order_reconcile.ts');
	await queueDeclaredOrderReconcile(changed);
}

/** Remove the node at `address` (its tipo only), under the tld's projection lock. Returns the rows removed (0 or 1). */
export async function unprojectOntologyNode(address: OntologyNodeAddress): Promise<number> {
	return withTransaction(async () => {
		await lockOntologyProjection([address.tld]);
		return deleteDdOntologyNode(address.tipo);
	});
}

/**
 * Whether the current principal may have record CONTENT written into the live
 * dd_ontology (module header, WHO MAY PROJECT CONTENT): a developer, and nobody
 * else — a missing principal (no request scope, an unauthenticated one) fails
 * CLOSED. Read through the request-context backstop — the lifecycle hook sits
 * under the write chokepoint, below every door that holds the principal.
 */
function mayProjectContent(): boolean {
	return currentPrincipal()?.isDeveloper === true;
}

/** The skipped outcome (and its operator warning) of a content branch refused to a non-developer. */
function developerOnly(context: string, tipo?: string): OntologyLifecycleOutcome {
	const reason = 'projection is developer-only';
	console.warn(
		`[ontology_projection] ${context}: not projected — ${reason}; the record stays as drift for the ontology tool`,
	);
	return tipo === undefined ? { action: 'skipped', reason } : { action: 'skipped', tipo, reason };
}

export interface OntologyLifecycleOutcome {
	action: 'deleted' | 'projected' | 'reprojected' | 'skipped' | 'refused' | 'none';
	tipo?: string;
	reason?: string;
}

/**
 * Project `address`, turning the NAMESPACE refusal (ForeignOntologyNodeRefused) into a
 * warning. Nothing else is swallowed: a grammar / constraint refusal or any other error
 * propagates and aborts the caller's unit. No savepoint is needed for that: the namespace
 * refusal is raised after a read-only parse and before any statement, so the caller's
 * transaction holds no failed statement when it goes on.
 */
async function projectTolerant(
	address: OntologyNodeAddress,
	context: string,
): Promise<'projected' | 'tldless' | 'refused'> {
	try {
		return (await projectOntologyNode(address)).kind;
	} catch (error) {
		if (!(error instanceof ForeignOntologyNodeRefused)) throw error;
		console.warn(
			`[ontology_projection] ${context}: ${address.sectionTipo}/${address.sectionId} not projected — ${error.line}`,
		);
		return 'refused';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

/** The ontology42 items of an override's relation image ([] when there are none). */
function overrideItems(relationImage: unknown): unknown[] {
	const items = isRecord(relationImage) ? relationImage[ONTOLOGY_OVERWRITE] : undefined;
	return Array.isArray(items) ? items : [];
}

/** The governed record one ontology42 locator addresses, or null. */
function overrideTarget(item: unknown): OntologyNodeAddress | null {
	if (!isRecord(item)) return null;
	const { section_tipo: sectionTipo, section_id: sectionId } = item;
	const idShaped = typeof sectionId === 'number' || typeof sectionId === 'string';
	return typeof sectionTipo === 'string' && idShaped
		? ontologyNodeAddress(sectionTipo, sectionId)
		: null;
}

/** The distinct governed records an override's ontology42 locators address. */
function overrideTargets(relationImage: unknown): OntologyNodeAddress[] {
	const targets = new Map<string, OntologyNodeAddress>();
	for (const item of overrideItems(relationImage)) {
		const address = overrideTarget(item);
		if (address !== null) targets.set(address.tipo, address);
	}
	return [...targets.values()];
}

type TolerantKind = Awaited<ReturnType<typeof projectTolerant>>;

const NO_PROJECTED_TARGET: OntologyLifecycleOutcome = {
	action: 'skipped',
	reason: 'no projected override target',
};

/** An override's lifecycle: re-parse each ALREADY-projected node it addresses. */
async function overrideLifecycle(
	relationImage: unknown,
	context: string,
): Promise<OntologyLifecycleOutcome> {
	const targets = overrideTargets(relationImage);
	if (targets.length === 0) return NO_PROJECTED_TARGET;
	if (!mayProjectContent()) return developerOnly(context);
	// Every target tld locked (sorted) BEFORE the existence reads below.
	await lockOntologyProjection(targets.map((target) => target.tld));
	const kinds = new Map<string, TolerantKind>();
	for (const target of targets) {
		if ((await readDdOntologyRow(target.tipo)) === null) continue;
		kinds.set(target.tipo, await projectTolerant(target, context));
	}
	return overrideOutcome(kinds);
}

/** What an override's re-parse answers: the re-projected tipos, else a refusal, else nothing. */
function overrideOutcome(kinds: ReadonlyMap<string, TolerantKind>): OntologyLifecycleOutcome {
	const reprojected = [...kinds].filter(([, kind]) => kind === 'projected').map(([tipo]) => tipo);
	if (reprojected.length > 0) return { action: 'reprojected', tipo: reprojected.join(',') };
	return [...kinds.values()].includes('refused')
		? { action: 'refused', reason: 'override target parses outside its namespace' }
		: NO_PROJECTED_TARGET;
}

/** What a governed birth's tolerant projection answers, by kind. */
const BIRTH_OUTCOME: Readonly<Record<TolerantKind, Omit<OntologyLifecycleOutcome, 'tipo'>>> = {
	projected: { action: 'projected' },
	refused: { action: 'refused', reason: 'record declares another tld' },
	tldless: { action: 'skipped', reason: 'record declares no tld' },
};

/** A governed record's birth: re-projected, only into a tld whose root is projected. */
async function governedBirth(
	address: OntologyNodeAddress,
	context: string,
): Promise<OntologyLifecycleOutcome> {
	if (!mayProjectContent()) return developerOnly(context, address.tipo);
	await lockOntologyProjection([address.tld]);
	if ((await readDdOntologyRow(`${address.tld}0`)) === null) {
		return { action: 'skipped', tipo: address.tipo, reason: 'tld not projected' };
	}
	return { tipo: address.tipo, ...BIRTH_OUTCOME[await projectTolerant(address, context)] };
}

/**
 * Move a record's dd_ontology node with its LIFECYCLE, inside the caller's
 * transaction (DML through the ambient `sql`; the cache fan-out is deferred to
 * the settle point by clearOntologyDerivedCaches itself). A rolled-back unit
 * rolls its projection back with it.
 *
 *  - governed `<tld>0/<id>`, `death`: the node `<tld><id>` is removed.
 *  - governed, `birth` (an undelete): re-projected — but only into a tld whose
 *    root `<tld>0` is projected (a torn-down tld — no root — is never
 *    re-planted). A record parsing into another namespace is REFUSED with a
 *    warning, never a throw (ForeignOntologyNodeRefused only — any other error
 *    aborts the unit): a restore is not blocked, and inspectOntology keeps
 *    naming the record as `foreign`.
 *  - `localontology0` (an override): each node its ontology42 addresses
 *    (`relationImage` = the before-image on death, the after-image on birth)
 *    is re-parsed — only when that node is already projected. The parser then
 *    picks the next-lowest override, or the canonical record. An override never
 *    deletes a canonical node and never creates one.
 *  - anything else: nothing (`none`, decided from the section tipo alone — no
 *    database read, so the chokepoints call this unconditionally).
 * Every branch that writes takes the tld's projection lock first; the CONTENT
 * branches (a governed birth, an override's re-parse) run only for a developer
 * principal (module header; no principal fails closed) — anyone else's answers
 * `skipped`.
 */
export async function projectOntologyRecordLifecycle(
	sectionTipo: string,
	sectionId: number,
	event: 'death' | 'birth',
	relationImage: unknown,
): Promise<OntologyLifecycleOutcome> {
	if (sectionTipo === LOCAL_ONTOLOGY_SECTION) {
		return withTransaction(() =>
			overrideLifecycle(relationImage, `override ${sectionTipo}/${sectionId} ${event}`),
		);
	}
	const address = ontologyNodeAddress(sectionTipo, sectionId);
	if (address === null) return { action: 'none' };
	if (event === 'birth') {
		return withTransaction(() => governedBirth(address, `undelete ${sectionTipo}/${sectionId}`));
	}
	await unprojectOntologyNode(address);
	return { action: 'deleted', tipo: address.tipo };
}
