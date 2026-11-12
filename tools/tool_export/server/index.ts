/**
 * tool_export server module — flat-table (export_tabulator) data export.
 *
 * Every action is READ-gated on the exported section (level >= 1 on
 * options.section_tipo); the handlers add what the declarative gate cannot see.
 *
 * get_export_grid: the synchronous NDJSON stream / buffered grid (API, MCP).
 * The handler additionally asserts level >= 1 on EVERY `options.sqo.section_tipo`
 * entry (PHP assert_section_array_permission — the SQO's section list is a
 * separate, caller-supplied target set).
 *
 * components_with_parent: ontology-only lookup (which relation components point
 * at a section carrying a component_relation_parent) for the per-column
 * parents-checkbox gate (WC-049).
 *
 * components_with_references: ontology-only lookup (which components derive
 * calculated relations — dd467/dd621 related) for the per-column references
 * checkbox (T0-9 D4); compileExportPlan refuses the flag elsewhere.
 *
 * THE SERVER-BUILT EXPORT (export_job.ts, preview.ts — tool_export at scale):
 *  - build_export_artifact  BACKGROUND, lane 'export': the same producer and
 *    the same SQO section gate as get_export_grid, written into the job's spool;
 *  - build_export_file      BACKGROUND, lane 'export_file': one downloadable file
 *    from an ended spool, answered as the owner-only download URL;
 *  - get_export_preview     one page of the spool (records, never split);
 *  - list_export_jobs       the caller's exports of the section (reconnect);
 *  - delete_export_job      the owner deletes one export + its files (frees
 *    quota); refused while it runs or a file is being built from it.
 * The two background actions are ADMITTED per user before the fork
 * (export_job.ts admitExportJob: at most DEDALO_EXPORT_JOBS_PER_USER queued or
 * running, else export.too_many_jobs — nothing queued; a file build also may
 * take at most every export_file slot but one, admitExportFileJob).
 * The download route (`httpRoutes`) and the TTL sweeper (`onBoot`) are
 * registered through the tool contract too, so src/ never names this tool.
 * The last four open only the CALLER's own jobs of the gated section. The
 * three READS (build_export_file, get_export_preview, list_export_jobs) also
 * re-ask the build's own read gates over the recorded options (export_job.ts
 * resolveOwnedJob → access.ts exportStillReadable — the download route asks
 * the same door). delete_export_job deliberately does NOT: it goes through the
 * discard door (export_job.ts resolveOwnedJobToDiscard — "may discard" is not
 * "may read"; the rationale lives there).
 */

import type { ToolServerModule } from '../../../src/core/tools/module.ts';
import { startExportArtifactSweeper } from './artifact_store.ts';
import { EXPORT_ARTIFACT_URL_PREFIX, serveExportArtifact } from './download.ts';
import {
	admitExportFileJob,
	admitExportJob,
	toolExportBuildArtifact,
	toolExportBuildFile,
	toolExportDeleteJob,
	toolExportListJobs,
} from './export_job.ts';
import { toolExportGetPreview } from './preview.ts';
import {
	toolExportComponentsWithParent,
	toolExportComponentsWithReferences,
	toolExportGetExportGrid,
} from './tool_export.ts';

export const tool: ToolServerModule = {
	name: 'tool_export',
	apiActions: {
		get_export_grid: { permission: 'section', minLevel: 1, handler: toolExportGetExportGrid },
		components_with_parent: {
			permission: 'section',
			minLevel: 1,
			handler: toolExportComponentsWithParent,
		},
		components_with_references: {
			permission: 'section',
			minLevel: 1,
			handler: toolExportComponentsWithReferences,
		},
		build_export_artifact: {
			permission: 'section',
			minLevel: 1,
			admit: admitExportJob,
			handler: toolExportBuildArtifact,
		},
		build_export_file: {
			permission: 'section',
			minLevel: 1,
			admit: admitExportFileJob,
			handler: toolExportBuildFile,
		},
		get_export_preview: { permission: 'section', minLevel: 1, handler: toolExportGetPreview },
		list_export_jobs: { permission: 'section', minLevel: 1, handler: toolExportListJobs },
		// READ-gated like its siblings: it removes only the caller's OWN export
		// files (never a matrix record) of the gated section, through the DISCARD
		// door, which deliberately does not re-ask the build's read gates
		// (export_job.ts resolveOwnedJobToDiscard).
		delete_export_job: { permission: 'section', minLevel: 1, handler: toolExportDeleteJob },
	},
	backgroundRunnable: ['build_export_artifact', 'build_export_file'],
	// A user's export walks every selected record: its own lane (budget 1 by
	// default, no deadline — src/core/media/jobs.ts), so it never spends the
	// media or maintenance budget. A file build reads a FINISHED spool and is
	// short: its own lane too ('export_file'), so a download never queues
	// behind another user's multi-hour walk.
	backgroundLanes: { build_export_artifact: 'export', build_export_file: 'export_file' },
	// The built files' download route (owner + live section read access, 404
	// otherwise — download.ts). Registered through the tool contract, so the
	// engine's router never names this tool (loader.ts toolHttpRouteFor).
	httpRoutes: [
		{
			pathPrefix: EXPORT_ARTIFACT_URL_PREFIX,
			handle: (request, pathname) => serveExportArtifact(pathname, request.headers.get('cookie')),
			// Serves record data (every export format): classified like every read
			// door (read_door_acl_tripwire lists it). Owner-only, and the BUILD'S
			// OWN gates re-asked on every request — the section, every sqo section,
			// every declared column (Gate A/B: the component grant), the dedalo_raw
			// frames, every runtime frontier grant, the record scope, the lifetime.
			readPosture: {
				posture: 'chokepoint',
				via: 'tools/tool_export/server/access.ts exportStillReadable (+ exportToolAuthorized)',
				reason:
					"the owner's own export only, re-checked per request through the build's own read gates, the component grant of every declared column included.",
			},
		},
	],
	// The TTL of the export files (DEDALO_EXPORT_ARTIFACTS_TTL_HOURS) and the
	// interrupted-job reclaim: once now and hourly, stopped on shutdown. A broken
	// export root is loud in the log, never a refusal to serve.
	onBoot: () => startExportArtifactSweeper(),
};
