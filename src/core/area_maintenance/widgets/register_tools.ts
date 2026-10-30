/**
 * register_tools widget — the tools registry panel + the reconcile action
 * (PHP widgets/register_tools wrapping tools_register).
 */

import { sql } from '../../db/postgres.ts';
import { getModelByTipo } from '../../ontology/resolver.ts';
import { TIPO, TOOLS_REGISTER_SECTION_TIPO } from '../../tools/ontology_map.ts';
import { gated, type WidgetModule, type WidgetResponse } from './support.ts';

/**
 * How the registry and the tools tree DISAGREE about one tool — the widget's
 * single classification, computed here so no consumer re-derives it:
 *
 *  - `ok`           registered, on disk, same version;
 *  - `outdated`     both sides known, the directory ships a different version
 *                   (the registry is the stale side) → an import fixes it;
 *  - `unregistered` on disk, no registry row → an import fixes it;
 *  - `missing`      registered, no directory → an import CANNOT reach it.
 *
 * Two clients read this (the panel table + the maintenance map's Tools node) and
 * both used to re-implement the predicates from the raw fields; the map's copy
 * simply forgot the version comparison, so it reported a healthy green node over
 * a red panel. One field, one truth.
 */
type ToolRegistryState = 'ok' | 'outdated' | 'unregistered' | 'missing';

/** One datalist row: a tool as the registry and the tools tree jointly see it. */
interface ToolListItem {
	name: string;
	warning: string | null;
	/** The version the tool's register.json DECLARES on disk (null = unparsable). */
	version: string | null;
	developer: string | null;
	/** The version the dd1324 registry carries (null = not registered). */
	installed_version: string | null;
	/** dd1354 — served so the panel's Active checkbox reflects the registry. */
	active: boolean;
	/** False = registered but its directory is gone; an import cannot touch it. */
	on_disk: boolean;
	/** The row's drift verdict — see ToolRegistryState. */
	state: ToolRegistryState;
}

/**
 * The datalist's drift, summarised: the names behind each non-ok state. Served
 * so a consumer that only needs the verdict (the map node) never has to walk the
 * rows, and so the two consumers cannot drift apart in their reading of them.
 */
interface RegistryStateSummary {
	total: number;
	outdated: string[];
	unregistered: string[];
	missing: string[];
}

/** Summarise the classified rows (names, in the datalist's own sorted order). */
function summarizeRegistryState(datalist: ToolListItem[]): RegistryStateSummary {
	const namesOf = (state: ToolRegistryState) =>
		datalist.filter((item) => item.state === state).map((item) => item.name);
	return {
		total: datalist.length,
		outdated: namesOf('outdated'),
		unregistered: namesOf('unregistered'),
		missing: namesOf('missing'),
	};
}

/**
 * register_tools panel (PHP widgets/register_tools::get_value →
 * tools_register::get_tools_files_list). Like PHP this JOINS the two sides —
 * the dd1324 registry rows and the tool DIRECTORIES the importer would scan —
 * so the panel can never offer a control over a tool the action cannot reach
 * (WC-057; before that this engine served the registry alone). Three row kinds:
 * registered+on disk (the normal state), registered with its directory gone
 * ('Not found on disk' — the client disables its checkbox), and on disk but
 * unregistered ('Not registered tool', PHP's wording; it registers ACTIVE
 * unless the admin unchecks it first).
 *
 * The two version columns come from the two SIDES of that join and never from
 * one: `installed_version` is the dd1324 row, `version` is what the directory's
 * register.json declares (readDeclaredVersion). Serving the registry into both —
 * as this engine did until 2026-08-02 — made a stale registry indistinguishable
 * from a synced one, silently disabling the client's mismatch alert and the
 * widget's danger badge, which are the panel's whole reason to exist.
 * Component tipos come from tool_ontology_map — never inline a registry tipo here.
 */
async function registerToolsGetValue(): Promise<WidgetResponse> {
	const rows = (await sql.unsafe(
		`SELECT string->'${TIPO.NAME}'->0->>'value' AS name,
		        string->'${TIPO.VERSION}'->0->>'value' AS version,
		        string->'${TIPO.DEVELOPER}'->0->>'value' AS developer,
		        relation->'${TIPO.ACTIVE}'->0->>'section_id' AS active_id
		 FROM matrix_tools
		 WHERE section_tipo = $1`,
		[TOOLS_REGISTER_SECTION_TIPO],
	)) as {
		name: string | null;
		version: string | null;
		developer: string | null;
		active_id: string | null;
	}[];

	// Cold path (a panel load), so the importer's scanner is loaded lazily —
	// dynamic-import rationale 3, engineering/CONVENTIONS.md §2.
	const { listToolDirectories, readDeclaredVersion } = await import('../../tools/register.ts');
	const directories = listToolDirectories();
	const onDisk = new Set(directories.map((entry) => entry.name));
	// name → declared version, read from each directory's register.json.
	const declared = new Map(
		await Promise.all(
			directories.map(async (entry) => [entry.name, await readDeclaredVersion(entry.dir)] as const),
		),
	);

	const datalist: ToolListItem[] = [];
	const registered = new Set<string>();
	for (const row of rows) {
		if (row.name === null || row.name === '') continue;
		registered.add(row.name);
		const present = onDisk.has(row.name);
		// No directory ⇒ nothing declares a version; the row is registry-only.
		const declaredVersion = present ? (declared.get(row.name) ?? null) : null;
		datalist.push({
			name: row.name,
			warning: present ? null : 'Not found on disk',
			version: declaredVersion,
			developer: row.developer,
			installed_version: row.version,
			// radioYes semantics: the FIRST dd64 locator, '1' = yes.
			active: row.active_id === '1',
			on_disk: present,
			state: !present
				? 'missing'
				: // Both sides must be KNOWN to call it drift: an unparsable
					// register.json is a broken package, not a stale registry.
					declaredVersion !== null && row.version !== null && declaredVersion !== row.version
					? 'outdated'
					: 'ok',
		});
	}
	for (const name of onDisk) {
		if (registered.has(name)) continue;
		datalist.push({
			name,
			warning: 'Not registered tool',
			// Nothing is REGISTERED yet, but the directory still declares a version;
			// it registers active unless the admin unchecks it.
			version: declared.get(name) ?? null,
			developer: null,
			installed_version: null,
			active: true,
			on_disk: true,
			state: 'unregistered',
		});
	}
	datalist.sort((a, b) => a.name.localeCompare(b.name));

	// PHP pre-flight: warn when the dd1644 Developer term is missing from the
	// ontology (an outdated matrix_tools schema would break imports)
	const errors =
		(await getModelByTipo(TIPO.DEVELOPER)) === null
			? ["Your Ontology is outdated. Term 'dd1644' (Developer) do not exists"]
			: null;

	return { data: { datalist, errors, registry_state: summarizeRegistryState(datalist) } };
}

/**
 * register_tools.register_tools — reconcile the TS-owned tools/ tree with the
 * dd1324 registry (PHP tools_register::import_tools). Because dd1324 is SHARED
 * with the live PHP install, this is DRY-RUN: it validates every tool package and reports which
 * would change, writing nothing. The report lists per-tool validity, whether the
 * registry already matches (empty diff = no-op), and any warnings.
 */
async function registerToolsImport(): Promise<WidgetResponse> {
	const { importTools } = await import('../../tools/register.ts');
	const report = await importTools();
	const dryRun = report[0]?.dryRun ?? true;
	const invalid = report.filter((item) => !item.valid);
	const wouldChange = report.filter(
		(item) => item.valid && (!item.inRegistry || item.diff.length > 0),
	);

	const invalidErrors = invalid.flatMap((item) => item.errors);
	return {
		data: {
			dry_run: dryRun,
			total: report.length,
			invalid_count: invalid.length,
			would_change_count: wouldChange.length,
			report,
		},
		msg: dryRun
			? `OK. Dry-run: ${report.length} tools scanned, ${wouldChange.length} would change, ${invalid.length} invalid. Registry not modified.`
			: `OK. ${report.length} tools registered.`,
		...(invalidErrors.length === 0 ? {} : { errors: invalidErrors }),
	};
}

/** A tool directory name (the importer's own pattern — never a path). */
const TOOL_NAME_RE = /^tool_[a-z0-9_]+$/;

/**
 * Read `options.tools_active` — the panel's per-tool ACTIVE checkboxes, name →
 * boolean (WC-057). Malformed pairs are DROPPED, not defaulted: a key that is
 * not a tool name or a value that is not a boolean carries no admin intent, and
 * guessing one could deactivate a tool nobody asked to touch. A dropped pair
 * simply leaves that tool on its register.json declaration.
 */
function readActiveOverrides(options: Record<string, unknown>): Record<string, boolean> {
	const raw = options.tools_active;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const overrides: Record<string, boolean> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!TOOL_NAME_RE.test(name)) continue;
		if (typeof value !== 'boolean') continue;
		overrides[name] = value;
	}
	return overrides;
}

/**
 * register_tools.register_tools OWNED mode (UPDATE_PROCESS Phase 1): when the
 * TS engine owns the install (core/update/ownership.ts) dd1324 is TS-owned and
 * the widget behaves like PHP `register_tools::register_tools` — always a real
 * import. Response bytes per the oracle: result = the per-tool import-result
 * array, msg = 'OK. Request done successfully' | 'Warning! Request done with
 * errors', errors = flat per-tool error strings. Report items keep the TS
 * installer shape {name,dir,version,imported,errors,warnings} plus `active`
 * (richer than PHP's file_info rows — ledgered divergence WC-057,
 * engineering/wire_contract/).
 *
 * The panel's checkboxes ride in as `options.tools_active` and outrank each
 * register.json's own `active` declaration — see applyActiveOverride. With no
 * such option (any other caller) the import is byte-for-byte what it was.
 */
async function registerToolsImportOwned(options: Record<string, unknown>): Promise<WidgetResponse> {
	const { importTools } = await import('../../tools/register.ts');
	const raw = await importTools({
		dryRun: false,
		activeOverrides: readActiveOverrides(options),
	});
	const report = raw.map((item) => ({
		name: item.name,
		dir: item.dir,
		version: item.version,
		imported: item.valid === true && item.dryRun !== true,
		errors: item.errors ?? [],
		warnings: item.warnings ?? [],
		active: item.active,
	}));
	const errors = report.flatMap((item) => item.errors);
	return {
		data: report,
		...(errors.length === 0 ? {} : { msg: 'Warning! Request done with errors', errors }),
	};
}

export const widget: WidgetModule = {
	spec: {
		id: 'register_tools',
		category: 'config',
		label: { kind: 'label', key: 'register_tools' },
	},
	apiActions: {
		// Ownership-gated (UPDATE_PROCESS Phase 1). Closed (coexisting): reconcile
		// the TS-owned tools/ tree with the dd1324 registry DRY-RUN — validates every tool and
		// reports the diff WITHOUT writing (engineering/TOOLS_SPEC.md write-parity
		// gate before enabling writes). Open (engine owns the install): real
		// import, PHP response bytes.
		register_tools: gated(
			'register_tools.register_tools',
			registerToolsImport,
			registerToolsImportOwned,
		),
	},
	getValue: registerToolsGetValue,
};
