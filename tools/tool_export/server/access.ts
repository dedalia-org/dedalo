/**
 * THE RE-CHECK OF A FINISHED EXPORT — the one door every later read of an
 * export asks (preview, file build, listing: export_job.ts resolveOwnedJob /
 * listOwnedExportJobs; the download route: download.ts).
 *
 * It re-asks THE BUILD'S OWN GATES over the options the manifest recorded —
 * the same functions, never a mirror of them, so the re-check can be neither
 * stricter (locking the owner out of an export it was entitled to) nor looser
 * (serving a column whose grant was revoked):
 *
 *  - the module gate: SECTION grant on `section_tipo` (every principal; an
 *    empty or non-string section_tipo is refused — nothing to check is not
 *    "allowed");
 *  - tool_export.ts `assertExportSqoSections`: SECTION grant on every
 *    `sqo.section_tipo` entry (every principal, a non-string entry refused);
 *  - the engine's declaration gate, `assertExportDeclarationReadable`
 *    (src/diffusion/export/grid.ts — Gate A + Gate B + the dedalo_raw frames,
 *    global admins exempt), the very function `openExportGrid` ran — over the
 *    dedalo_raw frame columns the build RECORDED (`frame_columns`), never a
 *    fresh discovery of them; a manifest without the list is bound to none
 *    (fail closed).
 *
 * Then the grants the WALK consulted beyond the declaration:
 *
 *  - its RUNTIME FRONTIER GRANTS: a stored locator may land in a section the
 *    declared ddo path never names (a multi-target portal, thesaurus terms
 *    spread over several TLD sections), and the build's frontier authorized
 *    each such (section, component) pair on the runtime identity
 *    (src/diffusion/resolve/resolver.ts assertExportCrossing →
 *    frontierComponentAllowed). The manifest records every pair it ALLOWED
 *    (`frontier_grants`) and each is re-asked through the same predicate; a
 *    manifest without the list is bound to none (fail closed). Global admins
 *    are exempt, as their walk carries no frontier.
 *
 * Then two properties of the EXPORT ITSELF, which no build gate covers:
 *
 *  - its RECORD SCOPE: the spool holds the records the owner's scope reached
 *    when the walk ran (the projects filter, the dd478 record allow-list + the
 *    runtime frontier, applied by the walk). `exportRecordScope` fingerprints
 *    that scope (global-admin flag; for everyone else the dd170 projects + the
 *    dd478 allow-list — a global admin's walk applies neither);
 *    the manifest recorded it at build, and a different answer now — the owner
 *    was removed from (or added to) a project, lost or gained global admin, or
 *    had their record allow-list changed — closes the export: every door answers not-found,
 *    nothing of the snapshot is served under a scope it was not taken for;
 *  - its LIFETIME: an export past its end + TTL (artifact_store.ts
 *    exportExpired, a hard ceiling no file build extends) is not-found at once,
 *    not at the next hourly sweep.
 *
 * WHAT IS NOT RE-CHECKED: a single RECORD whose own project filing changed
 * after the walk. The export is a snapshot of what the owner could read when it
 * ran (like a file they downloaded then); the lifetime ceiling bounds how long
 * the server keeps serving it.
 *
 * A refusal (`perm.denied`) answers false; anything else propagates.
 *
 * The TOOL gate (tool_export active + authorized for the user) is NOT part of
 * this re-check: the dispatcher applies it to every action door (Gates 3+4,
 * src/core/tools/dispatch.ts) before any of them reaches here. The download
 * route is the one door the dispatcher does not front, so it asks
 * `exportToolAuthorized` itself (download.ts).
 */

import { createHash } from 'node:crypto';
import { isDedaloError } from '../../../src/core/errors/index.ts';
import { getUserFilterRecords } from '../../../src/core/security/filter_records.ts';
import { frontierComponentAllowed } from '../../../src/core/security/frontier_scope.ts';
import {
	getPermissions,
	getUserProjects,
	type Principal,
} from '../../../src/core/security/permissions.ts';
import { isToolGranted } from '../../../src/core/tools/security.ts';
import {
	assertExportDeclarationReadable,
	type ExportFrameColumns,
} from '../../../src/diffusion/api/export.ts';
import { type ExportManifest, exportExpired } from './artifact_store.ts';
import { assertExportSqoSections } from './tool_export.ts';

/**
 * The principal's RECORD SCOPE, fingerprinted: what decides WHICH records a
 * walk with this principal reaches beyond the grants (which are re-asked
 * separately). EXACTLY what the walk applies (src/diffusion/export/grid.ts
 * openExportGrid selects through buildSearchSql with the caller's principal,
 * and with NONE for a global admin) — a wider fingerprint would make the
 * re-check stricter than the build, a narrower one looser:
 *  - a global admin: the flag alone (the walk is unscoped);
 *  - everyone else: their projects (dd170, the projects filter) AND their
 *    per-user record allow-list (dd478, security/filter_records.ts
 *    getUserFilterRecords — the assembler ANDs it into the selection).
 * Opaque; equal iff the scope is the same.
 */
export async function exportRecordScope(principal: Principal): Promise<string> {
	if (principal.isGlobalAdmin) {
		return createHash('sha256')
			.update(JSON.stringify({ global_admin: true }))
			.digest('hex')
			.slice(0, 32);
	}
	const allowList = await getUserFilterRecords(principal.userId);
	const records = [...allowList.entries()]
		.map(([sectionTipo, ids]): [string, number[]] => [
			sectionTipo,
			[...new Set(ids)].sort((a, b) => a - b),
		])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const scope = {
		global_admin: false,
		projects: [...new Set(await getUserProjects(principal.userId))].sort((a, b) => a - b),
		records,
	};
	return createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 32);
}

/**
 * What one DOOR INVOCATION may share across the manifests it re-checks: the
 * principal's record-scope fingerprint is a property of the principal, not of
 * the export, so a listing / reclaim over N exports computes it ONCE (the
 * dd478 allow-list read + sort + hash), never N times. Create one per call
 * (never across requests: the scope may change between them).
 */
export interface ExportReadCheckMemo {
	recordScope?: Promise<string>;
}

/** May `principal` still read the export `manifest` records? (see module doc) */
export async function exportStillReadable(
	principal: Principal,
	manifest: Pick<
		ExportManifest,
		| 'section_tipo'
		| 'options'
		| 'record_scope'
		| 'frontier_grants'
		| 'frame_columns'
		| 'status'
		| 'ended_at'
		| 'updated_at'
	>,
	store: { ttlHours: number },
	memo: ExportReadCheckMemo = {},
): Promise<boolean> {
	const sectionTipo = manifest.section_tipo;
	if (typeof sectionTipo !== 'string' || sectionTipo === '') return false;
	if (exportExpired(manifest, { ttlHours: store.ttlHours })) return false;
	// A manifest with no recorded scope is bound to none: fail closed.
	if (typeof manifest.record_scope !== 'string') return false;
	memo.recordScope ??= exportRecordScope(principal);
	if (manifest.record_scope !== (await memo.recordScope)) return false;
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) return false;
	// The section the build was gated on is the manifest's (the build required
	// options.section_tipo and recorded it as manifest.section_tipo).
	const options = {
		...(manifest.options !== null && typeof manifest.options === 'object' ? manifest.options : {}),
		section_tipo: sectionTipo,
	};
	// The frame columns the BUILD's gate authorized and emitted — re-asked as
	// recorded, never re-discovered (the discovered half of the set follows
	// stored data, so a fresh scan could omit a column the export still holds).
	const frameColumns = recordedFrameColumns(manifest.frame_columns);
	if (frameColumns === null) return false;
	try {
		await assertExportSqoSections(principal, options);
		await assertExportDeclarationReadable(principal, options, {
			noteRefusals: false,
			frameColumns,
		});
	} catch (error) {
		if (isDedaloError(error) && error.code === 'perm.denied') return false;
		throw error;
	}
	return runtimeFrontierGrantsHeld(principal, manifest.frontier_grants);
}

/**
 * The manifest's `frame_columns`, validated: a list of { section_tipo,
 * component_tipo, frame_tipos[] } with non-empty strings throughout. Anything
 * else — absent (a manifest written before the set was recorded), not a list,
 * a malformed entry — is null: the export is bound to no set (fail closed).
 */
function recordedFrameColumns(value: unknown): ExportFrameColumns[] | null {
	if (!Array.isArray(value)) return null;
	const columns: ExportFrameColumns[] = [];
	const tipo = (candidate: unknown): candidate is string =>
		typeof candidate === 'string' && candidate !== '';
	for (const entry of value) {
		const column = entry as Partial<ExportFrameColumns> | null;
		if (column === null || typeof column !== 'object') return null;
		if (!tipo(column.section_tipo) || !tipo(column.component_tipo)) return null;
		if (!Array.isArray(column.frame_tipos) || !column.frame_tipos.every(tipo)) return null;
		columns.push({
			section_tipo: column.section_tipo,
			component_tipo: column.component_tipo,
			frame_tipos: [...column.frame_tipos],
		});
	}
	return columns;
}

/**
 * Does `principal` still hold every RUNTIME grant the walk's frontier allowed
 * (manifest `frontier_grants`)? The build's own predicate, on the same scope
 * shape the walk carried (grid.ts openExportGridInScope: surface 'export', door
 * 'tool_export') — never a mirror of it. Not a list, or a malformed entry:
 * false (fail closed). A global admin's walk carried no frontier, so there is
 * nothing to re-ask.
 */
async function runtimeFrontierGrantsHeld(principal: Principal, grants: unknown): Promise<boolean> {
	if (!Array.isArray(grants)) return false;
	if (principal.isGlobalAdmin) return true;
	const scope = { principal, surface: 'export', door: 'tool_export' } as const;
	for (const grant of grants) {
		const sectionTipo = (grant as { section_tipo?: unknown } | null)?.section_tipo;
		const componentTipo = (grant as { component_tipo?: unknown } | null)?.component_tipo;
		if (typeof sectionTipo !== 'string' || typeof componentTipo !== 'string') return false;
		if (sectionTipo === '' || componentTipo === '') return false;
		if (!(await frontierComponentAllowed(scope, { sectionTipo, componentTipo }))) return false;
	}
	return true;
}

/** The tool this module serves — the name the dispatcher's tool gate checks. */
const EXPORT_TOOL_NAME = 'tool_export';

/**
 * Is tool_export ACTIVE (dd1324) and AUTHORIZED for `userId`? The dispatcher's
 * Gates 3+4, asked through the SAME decision (core/tools/security.ts
 * isToolGranted), never a mirror of it.
 */
export async function exportToolAuthorized(userId: number): Promise<boolean> {
	return isToolGranted(userId, EXPORT_TOOL_NAME);
}
