/**
 * Client-facing diffusion info + advisory + retry (the remaining
 * dd_diffusion_api actions the copied tool needs to RENDER its panels —
 * DIFFUSION_SPEC §2.3 action-set completeness).
 *
 * - get_diffusion_info ......... PHP dd_diffusion_api::get_diffusion_info
 *   (:355): { section_diffusion_nodes[], resolve_levels } — one accordion
 *   panel per node. Node shape per diffusion_utils::get_section_diffusion_nodes:
 *   { tipo, model, label, parents[], children[] } with per-child related
 *   info. The old Bun engine additionally stamped per-node readiness; we stamp
 *   `connection_status` (diffusion_utils::get_connection_status :971, WC-065):
 *   a REAL reachability verdict for elements whose target is a MariaDB
 *   database, and `null` for every other format — the client then omits the row
 *   entirely (render_tool_diffusion.js:594-611). A failed probe is a RENDERED
 *   negative verdict, never a thrown panel.
 *
 *   ITS SHAPE IS NOW `{ok, code?, message}` (P1 error sweep), not the PHP-era
 *   `{result, msg}`: it is a NESTED PAYLOAD, not an envelope, and a widget must
 *   branch on a registered code rather than on prose.
 * - get_engine_advisory ........ PHP dd_diffusion_api::get_engine_advisory
 *   (:1779): the client reads the body TOP-LEVEL ({state,title,checks,...},
 *   tool_diffusion.js:476-487). Natively there is no separate engine process
 *   — state reflects the in-process subsystem (job tables + target DB pool).
 * - retry_pending_deletions .... wraps the native retryPendingDiffusion()
 *   (dd1758 unpublish_pending rows, DIFFU-08 flip-in-place).
 */

import { readString } from '../../config/readers.ts';
import { nameOrLabelOf } from '../../core/ontology/labels.ts';
import { isMariadbTargetFormat } from '../plan/formats.ts';
import { requireSqlIdentifier } from '../plan/identifier.ts';
import type { VirtualPathItem, VirtualTreeNode } from '../plan/virtual_tree.ts';
import { buildVirtualDiffusionTree, getDatabaseNameForElement } from '../plan/virtual_tree.ts';
import { getTargetDatabaseStatus, type TargetDatabaseStatus } from '../targets/mariadb/db.ts';
import { WRITER_REGISTRY } from '../writers/registry.ts';

/** One child field descriptor (PHP get_section_diffusion_nodes children map). */
interface DiffusionNodeChild {
	tipo: string;
	model: string | null;
	label: string | null;
	related_tipo: string | null;
	related_model: string | null;
	related_label: string | null;
}

/**
 * Target-database readiness for one panel — the object the client reads
 * (`.ok` → css class, `.message` → text, `.code` → the registered reason).
 * ONE definition: the prober's own (targets/mariadb/db.ts), re-exported here
 * because this module is the panel's door.
 */
export type DiffusionConnectionStatus = TargetDatabaseStatus;

/** One accordion panel descriptor for the tool. */
export interface SectionDiffusionNode {
	tipo: string;
	model: string;
	label: string | null;
	/** The oracle's path items — `label` IS the panel header (WC-066). */
	parents: { tipo: string; model: string; label: string | null; type?: string }[];
	children: DiffusionNodeChild[];
	/** Element output format resolved from the parents path (native addition
	 * the old Bun enrichment also injected — the client shows readiness). */
	type: string | null;
	/** `{result,msg}` for a MariaDB target; null otherwise (row omitted). */
	connection_status: DiffusionConnectionStatus | null;
	/** Target database name for an `sql` element — the SANITIZED identifier the
	 * writer publishes into; null for every other type (row omitted). */
	database: string | null;
}

/** The oracle's verbatim verdict strings (class.diffusion_utils.php:984/:988). */
const MSG_DATABASE_NOT_READY = 'Database is NOT ready (missing or engine unreachable).';

/**
 * One `parents[]` entry as it goes on the wire (WC-066). PHP put the whole
 * path item there (`$item->parents = $vnode->parents`, :265), built as
 * `{tipo, model, label}` plus `type` ONLY on a diffusion_element(_alias)
 * (:345-352). The client depends on both extra fields: `label` IS the
 * accordion panel header (render_tool_diffusion.js:493) and the group key
 * (:462); `type` feeds the per-format switch (:842).
 *
 * `realTipo` is deliberately NOT emitted — a TS-only alias-resolution memo
 * the oracle never had; the client has no use for it.
 */
export function toWirePathItem(item: VirtualPathItem): {
	tipo: string;
	model: string;
	label: string | null;
	type?: string;
} {
	const wire: { tipo: string; model: string; label: string | null; type?: string } = {
		tipo: item.tipo,
		model: item.model,
		label: item.label,
	};
	// Present exactly when the builder stamped it (element models only) — it
	// already applied PHP's `?? 'unknown'` fallback, so never re-default here.
	if (item.type !== undefined) wire.type = item.type;
	return wire;
}

/** The diffusion element that owns `node` (nearest in the parents path). */
function elementOf(
	node: VirtualTreeNode,
	elementTypesByTipo: Map<string, string>,
): { tipo: string; type: string | null } | null {
	for (const pathItem of node.parents) {
		if (pathItem.model === 'diffusion_element' || pathItem.model === 'diffusion_element_alias') {
			return { tipo: pathItem.tipo, type: elementTypesByTipo.get(pathItem.tipo) ?? null };
		}
	}
	return null;
}

/**
 * One panel's connection_status (WC-065). `null` whenever the element does not
 * publish into a MariaDB database — PHP's `default: // ignore` (:1002), which
 * makes the client omit the whole row rather than report a meaningless verdict.
 *
 * NEVER throws and never propagates: an unresolvable database name or a failed
 * probe is exactly PHP's result:false case (it logged logger::WARNING and
 * returned the object so the panel still rendered, :991-996). A throw here
 * would blank the entire accordion.
 *
 * `database` arrives as the RAW ontology label (getDatabaseNameForElement →
 * node.label, institution-editable). It MUST pass the same requireSqlIdentifier
 * chokepoint the publish plan uses (compile.ts:576) and the delete map uses
 * (diffusion_map.ts:488) — that helper NORMALIZES (lowercase, non-[a-z0-9_] →
 * '_'), so probing the raw label would address a DIFFERENT database than the
 * one actually written to: a label like `Web MDCAT` publishes to `web_mdcat`
 * and would be reported "NOT ready" while perfectly healthy. This is the
 * raw-vs-sanitized drift DIFF-A removed on the delete path
 * (src/core/db/sql_identifier.ts:5-16) — one producer, no second name.
 *
 * The prober is injectable so the shape gate runs without MariaDB.
 */
/** The one negative verdict this module renders (never a throw — see above). */
function databaseNotReady(): DiffusionConnectionStatus {
	return { ok: false, code: 'diffusion.connection_failed', message: MSG_DATABASE_NOT_READY };
}

export async function connectionStatusForElement(
	type: string | null,
	database: string | null,
	nodeTipo: string,
	probe: (database: string) => Promise<DiffusionConnectionStatus> = getTargetDatabaseStatus,
): Promise<DiffusionConnectionStatus | null> {
	if (!isMariadbTargetFormat(type)) return null;
	if (database === null || database === '') {
		console.warn(
			`[diffusion] no target database resolved for connection_status [node ${nodeTipo}, type ${type}]`,
		);
		return databaseNotReady();
	}
	// Inside the try: requireSqlIdentifier THROWS on a label that cannot yield a
	// valid identifier, and that must degrade to a rendered negative verdict too.
	try {
		return await probe(requireSqlIdentifier(database, 'database'));
	} catch (error) {
		console.warn(
			`[diffusion] connection_status probe failed [node ${nodeTipo}, database ${database}]`,
			error,
		);
		return databaseNotReady();
	}
}

/**
 * The target database name a panel shows (native addition, no PHP twin). Only
 * an `sql` element has one worth naming — `socrata` shares the table target but
 * not the concept. It is the SANITIZED identifier (the same requireSqlIdentifier
 * chokepoint as the plan and the probe), never the raw label: `Web MDCAT` is
 * shown as `web_mdcat`, the database actually written to. Unresolvable or
 * invalid → null, never a throw (a throw would blank the accordion).
 */
export function sqlTargetDatabase(type: string | null, database: string | null): string | null {
	if (type !== 'sql' || database === null || database === '') return null;
	try {
		return requireSqlIdentifier(database, 'database');
	} catch {
		return null;
	}
}

/**
 * The tree nodes that become panels for `sectionTipo`: one panel per
 * PUBLICATION (nearest diffusion element) and node. A node reachable through
 * two elements — two `database_alias` nodes pointing at one shared `database`
 * (numisdata29 + numisdata891 → numisdata869) — is two publications into two
 * databases and panels twice, as PHP did (get_section_diffusion_nodes kept
 * every virtual node). Keying on the node tipo alone hid the second element's
 * panel, and with it its Publish button. The same node twice under ONE element
 * stays one panel: both would publish identically.
 */
export function selectPanelNodes(nodes: VirtualTreeNode[], sectionTipo: string): VirtualTreeNode[] {
	const selected: VirtualTreeNode[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		if (!node.relatedSections.includes(sectionTipo)) continue;
		const element = node.parents.find(
			(item) => item.model === 'diffusion_element' || item.model === 'diffusion_element_alias',
		);
		const key = `${element?.tipo ?? ''}|${node.tipo}`;
		if (seen.has(key)) continue;
		seen.add(key);
		selected.push(node);
	}
	return selected;
}

/** PHP get_diffusion_info result payload for one section. */
export async function buildDiffusionInfo(sectionTipo: string): Promise<{
	section_diffusion_nodes: SectionDiffusionNode[];
	resolve_levels: number;
}> {
	const resolveLevels = Math.max(0, Number(readString('DEDALO_DIFFUSION_RESOLVE_LEVELS')) || 2);
	const tree = await buildVirtualDiffusionTree();
	if (tree === null) {
		return { section_diffusion_nodes: [], resolve_levels: resolveLevels };
	}

	// Element tipo → declared output type (properties->diffusion->type).
	const elementTypesByTipo = new Map<string, string>();
	for (const node of tree.nodes) {
		if (node.model === 'diffusion_element' || node.model === 'diffusion_element_alias') {
			const declared = (node.properties as { diffusion?: { type?: unknown } } | null)?.diffusion
				?.type;
			if (typeof declared === 'string') elementTypesByTipo.set(node.tipo, declared);
		}
	}

	const items: SectionDiffusionNode[] = [];
	for (const node of selectPanelNodes(tree.nodes, sectionTipo)) {
		const children: DiffusionNodeChild[] = [];
		for (const childTipo of node.childrenTipos) {
			const childNode = await tree.index.nodeOf(childTipo);
			const relatedTipo = (await tree.index.relationTipos(childTipo))[0] ?? null;
			const relatedNode = relatedTipo === null ? null : await tree.index.nodeOf(relatedTipo);
			children.push({
				tipo: childTipo,
				model: childNode?.model ?? null,
				label: nameOrLabelOf(childNode),
				related_tipo: relatedTipo,
				related_model: relatedNode?.model ?? null,
				related_label: nameOrLabelOf(relatedNode),
			});
		}
		const element = elementOf(node, elementTypesByTipo);
		const type = element?.type ?? null;
		const databaseLabel = element === null ? null : getDatabaseNameForElement(tree, element.tipo);
		// The verdict is memoized per database in the mariadb layer, so N panels
		// over the same target cost ONE round-trip.
		const connectionStatus = await connectionStatusForElement(type, databaseLabel, node.tipo);
		items.push({
			tipo: node.tipo,
			model: node.model,
			label: node.label,
			parents: node.parents.map(toWirePathItem),
			children,
			type,
			connection_status: connectionStatus,
			database: sqlTargetDatabase(type, databaseLabel),
		});
	}
	return { section_diffusion_nodes: items, resolve_levels: resolveLevels };
}

/**
 * Native subsystem advisory (client-top-level shape).
 *
 * The data plane is in-process + spawned runners over the durable queue — there
 * is no separate engine to be "down". Target-DB failures surface per-run (loud
 * open() errors) and per-panel (connection_status).
 *
 * The DAEMON-ERA keys are gone (WC-076): `recovered`, `service_cmd_configured`
 * and `log_tail` described a supervised external process — whether its service
 * command was configured, whether an auto-recover attempt had restarted it, and
 * the tail of its log file. None of those referents exist. They were emitted as
 * a permanent `false`/`false`/`null`, which is not a neutral default: it is a
 * live-looking field that invites a client to branch on it. Retired instead of
 * frozen. Gate: diffusion_dispatch_gate.test.ts.
 */
export function buildEngineAdvisory(isAdmin: boolean): Record<string, unknown> {
	return {
		// No `result` key: `state` IS the verdict, and an envelope-shaped field
		// inside a nested payload is exactly what the P1 sweep removes.
		state: 'ok',
		is_admin: isAdmin,
		title: 'Diffusion ready (native engine)',
		cause: '',
		steps: [],
		actions: [],
		checks: {
			engine: 'native',
			formats: [...WRITER_REGISTRY.keys()],
		},
	};
}

/**
 * Facade re-export for the installer's test_diffusion_connection step
 * (DEC-19): core/install/db_probe.ts reaches MariaDB ONLY through this facade
 * (boundary_seam rule), never the mariadb internals directly. The probe opens a
 * throwaway connection from posted credentials and closes it immediately.
 */
export async function probeDiffusionConnection(creds: {
	host: string;
	port: number;
	socket?: string;
	database: string;
	username: string;
	password: string;
}): Promise<TargetDatabaseStatus> {
	const { probeAdhocMariadbConnection } = await import('../targets/mariadb/db.ts');
	return probeAdhocMariadbConnection(creds);
}
