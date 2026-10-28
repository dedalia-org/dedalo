/**
 * dd_diffusion_api handlers (WS-C S2-25 extraction — bodies moved VERBATIM
 * from api/dispatch.ts; dispatch keeps registry assembly + gates + envelope).
 *
 * Diffusion rebuild control plane (engineering/DIFFUSION_SPEC.md §4.2): the copied
 * tool_diffusion client reaches these via its main-API fallback. Wire shapes
 * pinned in test/parity/fixtures/diffusion/pinned.ts.
 *
 * BOUNDARY: this file is the sanctioned core→diffusion dynamic-import SEAM
 * (diffusion_boundaries.test.ts DIFFUSION_IMPORT_SEAMS) — the handlers lazily
 * `await import(...)` the diffusion ACTION facade for registration. The one
 * grandfathered non-facade import (plan/compile.ts validateElementPlan) is
 * ledgered in boundary_seam_tripwire.test.ts and clears when it is re-exported
 * through diffusion/api/actions.ts.
 */

import { DedaloError, ok } from '../../errors/index.ts';
import { type ActionHandler, requirePrincipal } from '../handler_context.ts';

/** dd_diffusion_api action handlers, keyed by action (registered in dispatch.ts). */
export const diffusionApiActions: Record<string, ActionHandler> = {
	diffuse: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const { diffuseAction } = await import('../../../diffusion/api/actions.ts');
		return diffuseAction(rqo, principal);
	},
	get_process_status: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const { getProcessStatusAction } = await import('../../../diffusion/api/actions.ts');
		return getProcessStatusAction(rqo, principal);
	},
	list_processes: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const { listProcessesAction } = await import('../../../diffusion/api/actions.ts');
		return listProcessesAction(rqo, principal);
	},
	cancel_process: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const { cancelProcessAction } = await import('../../../diffusion/api/actions.ts');
		return cancelProcessAction(rqo, principal);
	},
	get_diffusion_info: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const { getDiffusionInfoAction } = await import('../../../diffusion/api/actions.ts');
		return getDiffusionInfoAction(rqo, principal);
	},
	get_engine_advisory: async (rqo, context) => {
		const principal = requirePrincipal(context);
		const { getEngineAdvisoryAction } = await import('../../../diffusion/api/actions.ts');
		return getEngineAdvisoryAction(rqo, principal);
	},
	follow_queue: async (rqo, context) => {
		// Admin-only, and MORE sensitive than its owner-scoped siblings: every
		// frame names every owner's running job — precisely what ownerScope()
		// withholds from get_process_status / list_processes. The gate runs
		// before any queue is opened or read.
		//
		// (!) The refusal is an SSE frame, not the JSON envelope the other
		// actions return — see queueRefusalStream for why a stream client
		// cannot receive a JSON refusal.
		const principal = requirePrincipal(context);
		if (!principal.isGlobalAdmin) {
			const { queueRefusalStream } = await import('../../../diffusion/api/actions.ts');
			return queueRefusalStream('insufficient permissions');
		}
		const { followQueueAction } = await import('../../../diffusion/api/actions.ts');
		return followQueueAction(rqo, principal);
	},
	count_pending_deletions: async (_rqo, context) => {
		// Admin-only like the retry it counts for (DIFF-02): the pending queue is global.
		const principal = requirePrincipal(context);
		if (!principal.isGlobalAdmin) {
			throw new DedaloError('perm.denied', {
				coordinates: { action: 'count_pending_deletions', required: 'global_admin' },
			});
		}
		const { countPendingDeletionsAction } = await import('../../../diffusion/api/actions.ts');
		return countPendingDeletionsAction();
	},
	retry_pending_deletions: async (rqo, context) => {
		// Admin-only (DIFF-02): re-drives the GLOBAL dd1758 pending-unpublish queue
		// — background load a non-admin must not be able to trigger. Its siblings
		// validate / rebuild_media_index are admin-gated the same way.
		const principal = requirePrincipal(context);
		if (!principal.isGlobalAdmin) {
			throw new DedaloError('perm.denied', {
				coordinates: { action: 'retry_pending_deletions', required: 'global_admin' },
			});
		}
		const { retryPendingDeletionsAction } = await import('../../../diffusion/api/actions.ts');
		return retryPendingDeletionsAction(rqo, principal);
	},
	sweep_published_langs: async (rqo, context) => {
		// Admin-only: the published-lang coherence audit (mode:'report', the
		// default) and, behind confirm:true, the DELETION of published rows whose
		// lang the policy no longer names — a cross-section destructive operation
		// on the publication server, gated exactly like retry_pending_deletions /
		// rebuild_media_index. The gate is duplicated inside the action too
		// (diffusion/api/actions.ts): a wiring mistake must not be able to remove
		// a permission check.
		const principal = requirePrincipal(context);
		if (!principal.isGlobalAdmin) {
			throw new DedaloError('perm.denied', {
				coordinates: { action: 'sweep_published_langs', required: 'global_admin' },
			});
		}
		const { sweepPublishedLangsAction } = await import('../../../diffusion/api/actions.ts');
		return sweepPublishedLangsAction(rqo, principal);
	},
	validate: async (rqo, context) => {
		// Admin-only plan validation (PHP dd_diffusion_api::validate): compiles
		// the element and reports errors/warnings — the loud pre-run gate.
		const principal = requirePrincipal(context);
		if (!principal.isGlobalAdmin) {
			throw new DedaloError('perm.denied', {
				coordinates: { action: 'validate', required: 'global_admin' },
			});
		}
		const options = (rqo.options ?? {}) as { diffusion_element_tipo?: unknown };
		const elementTipo =
			typeof options.diffusion_element_tipo === 'string' ? options.diffusion_element_tipo : null;
		if (elementTipo === null) {
			throw new DedaloError('request.invalid_options', {
				publicMessage: 'options.diffusion_element_tipo is required',
			});
		}
		const { validateElementPlan } = await import('../../../diffusion/plan/compile.ts');
		// The validation report IS the data (`{result: plan|null, errors, warnings,
		// degradations}` — a compile that fails is a REPORT here, not a refusal).
		const validation = await validateElementPlan(elementTipo);
		return { status: 200, body: ok(validation, { requestId: context.requestId }) };
	},
	rebuild_media_index: async (_rqo, context) => {
		// Full media-marker resync (PHP dd_diffusion_api::rebuild_media_index):
		// every sql/socrata publication target of the diffusion map is sent to
		// the Bun engine, which regenerates the .publication/pub store.
		// Cross-section operation — global admins only (PHP message parity).
		const principal = requirePrincipal(context);
		if (!principal.isGlobalAdmin) {
			throw new DedaloError('perm.denied', {
				coordinates: { action: 'rebuild_media_index', required: 'global_admin' },
			});
		}
		const { rebuildMediaIndex } = await import('../../diffusion_bridge/diffusion_delete.ts');
		// rebuildMediaIndex ANSWERS with a report and THROWS on failure (envelope
		// v2): the report is the data.
		const report = await rebuildMediaIndex();
		return { status: 200, body: ok(report, { requestId: context.requestId }) };
	},
};
