/**
 * register_tools (PHP installer register_tools). Populates the shared tool
 * registry (matrix_tools / dd1324) from THIS server's own tools tree
 * (each tools/<name>/register.json). Reuses the existing import machinery
 * (core/tools/register.ts importTools)
 * with dryRun:false — a fresh install has an empty matrix_tools and must be
 * populated for the tools to appear in the UI.
 *
 * Response shape: `{ok, errors, report:[{name,dir,version,imported,errors,
 * warnings}]}`, read by the terminal installer's step table (step_runs.ts).
 */

export interface RegisterToolsReportItem {
	name: string;
	dir: string;
	version: string | null;
	imported: boolean;
	errors: string[];
	warnings: string[];
}

export interface RegisterToolsResult {
	/** A REPORT flag: a run with per-tool errors still ran (see db_probe_plan.ts). */
	ok: boolean;
	msg: string;
	errors: string[];
	report: RegisterToolsReportItem[];
}

/** Import every discoverable tool registration into matrix_tools. */
/*
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a ONE-SHOT install procedure that
 * MUTATES THE MACHINE — config files, a database restore, root credentials, a
 * 126 MB hierarchy import, or a process restart. Blocked by DANGER, not by
 * fixture: the hermetic logic in the same subsystem (deriveLangConfig,
 * pgBinaryCandidates, the hierarchy_meta readers) IS gated
 * (test/unit/tier1_install_native.test.ts).
 */
export async function registerInstallTools(): Promise<RegisterToolsResult> {
	const { importTools } = await import('../tools/register.ts');
	const raw = await importTools({ dryRun: false });
	const report: RegisterToolsReportItem[] = raw.map((item) => ({
		name: item.name,
		dir: item.dir,
		version: item.version,
		imported: item.valid === true && item.dryRun !== true,
		errors: item.errors ?? [],
		warnings: item.warnings ?? [],
	}));
	const failed = report.filter((item) => item.errors.length > 0);
	return {
		ok: failed.length === 0,
		msg:
			failed.length === 0
				? `Registered ${report.length} tool(s)`
				: `Registered ${report.length - failed.length}/${report.length} tool(s); ${failed.length} had errors`,
		errors: failed.flatMap((item) => item.errors),
		report,
	};
}
