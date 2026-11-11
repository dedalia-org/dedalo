/**
 * src/diffusion/export — tool_export unified onto the shared diffusion engine
 * (DIFFUSION_PLAN D8/P6). Modules:
 *
 * - compile_columns.ts — ar_ddo_to_export → PublicationPlan (stage B, the
 *   second plan front-end);
 * - atoms.ts — shared-walk atom events → export atoms (value joins,
 *   grid_value per-target atoms) — export's OWN projection;
 * - grid.ts — the pinned meta/col/row/end NDJSON protocol + the three data
 *   formats + breakdown placement — export's OWN writer. `openExportGrid` is
 *   the ONE line producer (usable outside a request, cancellable at batch
 *   boundaries); `exportGridUnified` is its thin tool-envelope user.
 * - row_media.ts — the out-of-band media-address channel (a capturing walk's
 *   row lines → the tool_export spool's media.ndjson → the media ZIP).
 *
 * tools/tool_export/server/tool_export.ts is a thin facade over this module —
 * the SINGLE implementation since the ledgered legacy-walker deletion landed
 * (2026-07-08, with the deep-breakdown export_tabulator rebuild).
 */

export { exportPathMayReachMedia } from './atoms.ts';
export type { ExportDdoInput } from './compile_columns.ts';
export { compileExportPlan } from './compile_columns.ts';
export type {
	ExportExternalDegradation,
	ExportExternalDegradedCell,
	ExportExternalDegradedState,
} from './external_prefetch.ts';
export type {
	ExportDeclarationGateOptions,
	ExportGridContext,
	ExportGridRunOptions,
	OpenedExportGrid,
} from './grid.ts';
export { assertExportDeclarationReadable, exportGridUnified, openExportGrid } from './grid.ts';
export { ndjsonStream } from './ndjson_stream.ts';
export type { ExportRowMediaAddress, RowLineWithMedia } from './row_media.ts';
export { EXPORT_ROW_MEDIA, parseRowMediaAddress, rowMediaOf } from './row_media.ts';
