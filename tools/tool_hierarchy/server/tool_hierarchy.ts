/**
 * tool_hierarchy handler — the hierarchy CONSISTENCY tool.
 *
 * Two actions, one writer:
 *
 *  - `inspect_hierarchy` (READ) — the invariant checklist for this hierarchy
 *    (ontology/src/core/ontology/hierarchy_state.ts `inspectHierarchy`). The client
 *    renders it as a status panel, so an operator can SEE why a hierarchy is unusable
 *    instead of pressing a button and hoping.
 *
 *  - `generate_virtual_section` (WRITE) — converge to that invariant
 *    (`ensureHierarchy`), or, with force_to_create, delete the hierarchy's ontology
 *    from scratch and re-provision it (`rebuildHierarchy`) — an OWNED case 1
 *    hierarchy only; any other is refused `ontology.teardown_refused` + `reason`
 *    before a write (HIER-REBUILD). The name is kept because the client action + the
 *    tool registry are wire contract; the SEMANTICS are now "make this hierarchy
 *    consistent", which is what pressing it always meant.
 *
 * This handler no longer sequences provisioning + root-term seeding itself. It used to,
 * and that is exactly how it broke: `createThesaurusGeneralTerm` skipped the root term
 * whenever the hierarchy45 locator was merely PRESENT, and the seed presets a DANGLING
 * one on 158 of 269 records — so a hierarchy whose thesaurus had not been imported got
 * an ontology, an active flag, and a pointer to a term that never existed (live: Albania).
 * The invariant, and every write that establishes it, now lives in ONE module.
 *
 * WRITE gate (permission:'targets', level >= 2 on hierarchy1/<section_id>) is enforced
 * by the dispatcher before this handler runs — see hierarchyTargets: the target is the
 * record the state module is PINNED to, not the section_tipo the client happens to send.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { clearOntologyDerivedCaches } from '../../../src/core/ontology/cache_invalidation.ts';
import {
	classifyHierarchyRebuild,
	ensureHierarchy,
	HIERARCHY_SECTION,
	inspectHierarchy,
	rebuildHierarchy,
} from '../../../src/core/ontology/hierarchy_state.ts';
import { deleteSectionRecord } from '../../../src/core/section/record/delete_record.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
	type WriteTarget,
} from '../../../src/core/tools/module.ts';

/** Neither action can address a hierarchy without its record — a caller fault. */
function missingTarget(action: string): DedaloError {
	return new DedaloError('request.invalid_options', {
		coordinates: { action },
		message: `Missing section_id or section_tipo [${action}]`,
		publicMessage: `section_tipo '${HIERARCHY_SECTION}' and a positive section_id are required`,
	});
}

/**
 * The ONE record both actions address: `hierarchy1/<options.section_id>`.
 *
 * `inspectHierarchy` / `ensureHierarchy` / `rebuildHierarchy` take only the id
 * and write HIERARCHY_SECTION by constant, so `options.section_tipo` can name
 * nothing else: a request carrying any other section is refused here as
 * unusable, and — the half that matters — the 'targets' gate authorizes the
 * pinned pair BEFORE this handler runs (hierarchyTargets), so a write grant on
 * some unrelated section is no longer authority to rewrite a hierarchy record
 * (audit CARRY-08 / TOOLS-04).
 */
function targetOf(context: ToolActionContext): { sectionTipo: string; sectionId: number } | null {
	const sectionTipo =
		typeof context.options.section_tipo === 'string' ? context.options.section_tipo : '';
	const raw = context.options.section_id;
	const sectionId = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
	if (sectionTipo !== HIERARCHY_SECTION || !Number.isFinite(sectionId) || sectionId <= 0) {
		return null;
	}
	return { sectionTipo, sectionId };
}

/**
 * The 'targets' extractor for BOTH actions: the pinned hierarchy record. The
 * gate validates the id (a positive integer, inside the caller's scope) and the
 * level on HIERARCHY_SECTION itself — the client's `section_tipo` is deliberately
 * NOT consulted for the grant, because the writer never consults it either;
 * targetOf above refuses a mismatching one as a caller fault.
 */
export function hierarchyTargets(options: Record<string, unknown>): WriteTarget[] {
	// `?? null`: an ABSENT id must be a record-target denial, not a section-only
	// pass — the gate skips the record half only when no id is named at all.
	return [{ section_tipo: HIERARCHY_SECTION, section_id: options.section_id ?? null }];
}

/**
 * READ: the invariant checklist the client renders as the status panel, plus
 * `rebuild` = {allowed, reason} — whether "Force to create" may run on this
 * hierarchy (hierarchy_state.ts classifyHierarchyRebuild, the same verdict the
 * write door enforces), so the panel disables it and says why
 * (WC-2026-11-10-hierarchy-rebuild-ownership).
 */
export async function toolHierarchyInspect(context: ToolActionContext): Promise<ToolResponse> {
	const target = targetOf(context);
	if (target === null) throw missingTarget('inspect_hierarchy');
	// `usable` inside the state IS the verdict the panel renders — the legacy
	// body's 'Hierarchy is ready/incomplete' msg only restated it.
	const state = await inspectHierarchy(target.sectionId);
	const verdict = await classifyHierarchyRebuild(target.sectionId);
	return ok(
		{ state, rebuild: { allowed: verdict.allowed, reason: verdict.reason } },
		{ requestId: toolRequestId(context) },
	);
}

/** WRITE: converge to the invariant (force_to_create → tear the ontology down first). */
export async function toolHierarchyGenerateVirtualSection(
	context: ToolActionContext,
): Promise<ToolResponse> {
	const target = targetOf(context);
	if (target === null) throw missingTarget('generate_virtual_section');
	const forceToCreate = context.options.force_to_create === true;

	const outcome = forceToCreate
		? await rebuildHierarchy(target.sectionId, context.userId, (st, sid) =>
				deleteSectionRecord(st, sid, context.userId),
			)
		: await ensureHierarchy(target.sectionId, context.userId);

	// The menu/tree read ontology-derived caches; a provisioned tld must show up now.
	await clearOntologyDerivedCaches();

	if (!outcome.ok) {
		// A NAMED failure extension key (ERRORS_SPEC §3.0, the `start`/`environment`
		// precedent): the refused client re-renders its checklist from `state`, and
		// without it the panel can only print a sentence. `errors` is the per-check
		// detail behind that same panel.
		throw new DedaloError('tool.action_failed', {
			coordinates: { section_tipo: target.sectionTipo, section_id: target.sectionId },
			message: outcome.msg,
			extend: { state: outcome.state, errors: outcome.errors },
		});
	}
	return ok(
		{ state: outcome.state, applied: outcome.applied, summary: outcome.msg },
		{ requestId: toolRequestId(context) },
	);
}
