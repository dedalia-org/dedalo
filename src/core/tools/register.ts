/**
 * Tool registration (PHP tools_register::import_tools).
 *
 * Scans the tool roots, parses each register.json, validates it, and reconciles
 * the tools registry (dd1324 in matrix_tools). A bare importTools() is a DRY RUN
 * (it computes, per tool, whether the registry already reflects the tool's
 * declared identity and returns a diff, writing nothing); a caller WRITES by
 * passing `dryRun: false` — the installer, the Register tools widget, the update
 * run's ancillary phase. (The TOOLS_ENABLE_REGISTRY_IMPORT switch that once gated
 * this, while the registry was shared with a live PHP install, was retired on
 * 2026-10-30 — update audit 2026-10-29, U-39: no caller consulted it any more.
 *
 * Format detection mirrors PHP:
 *   - top-level `components` key → legacy v6 dump (NOT supported this wave);
 *   - top-level `name` key       → flat AUTHORING format → converted here;
 *   - column-keyed (`data`/`string`/`relation`) → pass-through (the 34 seeded
 *     files are this form).
 */

import { existsSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertMatrixTable } from '../db/matrix.ts';
import {
	insertMatrixRecordWithCounter,
	readMatrixKeyForUpdate,
	updateMatrixRecord,
} from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import { invalidateAllToolCaches } from './cache.ts';
import { getLoadedTool } from './loader.ts';
import { DD64_SECTION_TIPO, TIPO, TOOLS_REGISTER_SECTION_TIPO } from './ontology_map.ts';
import { getRoots } from './paths.ts';
import { authoringRegisterSchema } from './register_schema.ts';

/** Column-keyed tool record (the register.json dump shape / import unit). */
export interface ToolRecord {
	string?: Record<string, { lang?: string; value?: string }[] | undefined>;
	// KEPT UNION: this is the on-disk `register.json` shape, authored by hand and
	// shipped in the repo with quoted ids ("section_id": "1"). Those FILE bytes
	// are not matrix data and no sweep rewrites them; the write path
	// canonicalizes on the way into the record.
	relation?: Record<string, { section_id?: string | number; section_tipo?: string }[] | undefined>;
	misc?: Record<string, { value?: unknown }[] | undefined>;
	[column: string]: unknown;
}

/** A registry row read back from dd1324 (record + its matrix coordinates). */
export interface RegistryRow {
	sectionId: number;
	record: ToolRecord;
}

/** One tool's outcome in an import report. */
export interface ImportReportItem {
	name: string;
	dir: string;
	valid: boolean;
	dryRun: boolean;
	/** Errors that would block registration (invalid register.json / contract). */
	errors: string[];
	/** Non-blocking notes (e.g. no server module). */
	warnings: string[];
	/** True when a matching dd1324 registry record already exists. */
	inRegistry: boolean;
	/** Identity fields that differ between register.json and the registry row. */
	diff: string[];
	/** True when the tool ships a loadable server module. */
	hasServerModule: boolean;
	/**
	 * The dd1354 active state this run writes (or would write): the caller's
	 * `activeOverrides[name]` when given, else the register.json declaration.
	 * `false` on an item that bailed before its record was parsed — nothing is
	 * written for those, so the field only describes attempted writes.
	 */
	active: boolean;
	/**
	 * The version the register.json declares (`null` when the item bailed before
	 * parsing). Consumers used to read a `record.version` that this interface
	 * never carried, so every report showed `version: null` — the widget response
	 * and the installer's per-tool rows alike.
	 */
	version: string | null;
	/**
	 * The registry WRITE failed (dryRun:false) — distinct from an invalid
	 * register.json: the declaration was fine, dd1324 still holds the old row.
	 * The update run fails its ancillary phase on it (review 2026-10-30 #11).
	 */
	writeFailed?: boolean;
}

// The tool components grouped by their matrix column (fixed contract — avoids a
// per-tipo DB model lookup during validation). Typed readonly string[] so the
// columnForTipo membership tests accept arbitrary tipos (pre-existing tsc fix).
const STRING_TIPOS: readonly string[] = [
	TIPO.NAME,
	TIPO.VERSION,
	TIPO.LABEL,
	TIPO.DEDALO_VERSION_MIN,
	TIPO.DEVELOPER,
	TIPO.DESCRIPTION,
];
const RELATION_TIPOS: readonly string[] = [
	TIPO.AFFECTED_MODELS,
	TIPO.ACTIVE,
	TIPO.SHOW_IN_INSPECTOR,
	TIPO.SHOW_IN_COMPONENT,
	TIPO.REQUIRE_TRANSLATABLE,
	TIPO.ALWAYS_ACTIVE,
];
const MISC_TIPOS: readonly string[] = [
	TIPO.PROPERTIES,
	TIPO.LABELS,
	TIPO.CONFIG,
	TIPO.DEFAULT_CONFIG,
	TIPO.ONTOLOGY,
	TIPO.AFFECTED_TIPOS,
];

/** The matrix column a tool component tipo lives in. */
function columnForTipo(tipo: string): 'string' | 'relation' | 'misc' | null {
	if (STRING_TIPOS.includes(tipo)) return 'string';
	if (RELATION_TIPOS.includes(tipo)) return 'relation';
	if (MISC_TIPOS.includes(tipo)) return 'misc';
	return null;
}

/** All items of a component tipo in a column-keyed record. */
function getItems(record: ToolRecord, tipo: string): { value?: unknown }[] | null {
	const column = columnForTipo(tipo);
	if (column === null) return null;
	const bag = (record[column] as Record<string, unknown[]> | undefined)?.[tipo];
	return Array.isArray(bag) ? (bag as { value?: unknown }[]) : null;
}

/** Detect the register.json format. */
export function detectFormat(raw: unknown): 'v6' | 'authoring' | 'column' | 'invalid' {
	if (raw === null || typeof raw !== 'object') return 'invalid';
	const object = raw as Record<string, unknown>;
	if ('components' in object) return 'v6';
	if (typeof object.name === 'string') return 'authoring';
	if ('data' in object || 'string' in object || 'relation' in object) return 'column';
	return 'invalid';
}

/** A dd64 yes/no locator for a boolean flag (PHP: yes = section_id '1'). */
function boolLocator(flag: boolean | undefined, componentTipo: string) {
	return {
		id: 1,
		type: 'dd151',
		section_id: flag === true ? '1' : '2',
		section_tipo: DD64_SECTION_TIPO,
		from_component_tipo: componentTipo,
	};
}

/** A nolan string item. */
function nolanString(value: string) {
	return [{ id: 1, lang: 'lg-nolan', value }];
}

/**
 * Convert the flat AUTHORING format to the column-keyed record (PHP
 * convert_register_authoring_to_v7). Affected-model NAMES are resolved to their
 * dd1342 locators.
 */
export async function convertAuthoringToV7(authoring: unknown): Promise<ToolRecord> {
	const parsed = authoringRegisterSchema.parse(authoring);

	const stringColumn: Record<string, unknown> = {
		[TIPO.NAME]: nolanString(parsed.name),
		[TIPO.VERSION]: nolanString(parsed.version),
		[TIPO.LABEL]: Object.entries(parsed.label).map(([lang, value], index) => ({
			id: index + 1,
			lang,
			value,
		})),
	};
	if (parsed.dedalo_version_min !== undefined) {
		stringColumn[TIPO.DEDALO_VERSION_MIN] = nolanString(parsed.dedalo_version_min);
	}
	if (parsed.developer !== undefined) {
		stringColumn[TIPO.DEVELOPER] = nolanString(parsed.developer);
	}
	if (parsed.description !== undefined) {
		stringColumn[TIPO.DESCRIPTION] = Object.entries(parsed.description).map(
			([lang, value], index) => ({ id: index + 1, lang, value }),
		);
	}

	const modelLocators = await resolveAffectedModelLocators(parsed.affected_models ?? []);
	const relationColumn: Record<string, unknown> = {
		[TIPO.AFFECTED_MODELS]: modelLocators,
		[TIPO.ACTIVE]: [boolLocator(parsed.active ?? true, TIPO.ACTIVE)],
		[TIPO.SHOW_IN_INSPECTOR]: [boolLocator(parsed.show_in_inspector, TIPO.SHOW_IN_INSPECTOR)],
		[TIPO.SHOW_IN_COMPONENT]: [boolLocator(parsed.show_in_component, TIPO.SHOW_IN_COMPONENT)],
		[TIPO.REQUIRE_TRANSLATABLE]: [
			boolLocator(parsed.require_translatable, TIPO.REQUIRE_TRANSLATABLE),
		],
		[TIPO.ALWAYS_ACTIVE]: [boolLocator(parsed.always_active, TIPO.ALWAYS_ACTIVE)],
	};

	const miscColumn: Record<string, unknown> = {};
	if (parsed.properties !== undefined)
		miscColumn[TIPO.PROPERTIES] = [{ id: 1, value: parsed.properties }];
	if (parsed.labels !== undefined) miscColumn[TIPO.LABELS] = [{ id: 1, value: parsed.labels }];
	if (parsed.config !== undefined) miscColumn[TIPO.CONFIG] = [{ id: 1, value: parsed.config }];
	if (parsed.default_config !== undefined) {
		miscColumn[TIPO.DEFAULT_CONFIG] = [{ id: 1, value: parsed.default_config }];
	}
	if (parsed.ontology !== undefined)
		miscColumn[TIPO.ONTOLOGY] = [{ id: 1, value: parsed.ontology }];
	if (parsed.affected_tipos !== undefined) {
		miscColumn[TIPO.AFFECTED_TIPOS] = [{ id: 1, value: parsed.affected_tipos }];
	}

	return {
		data: {},
		string: stringColumn,
		relation: relationColumn,
		misc: miscColumn,
	} as ToolRecord;
}

/** Resolve model names to dd1342 locators (PHP resolve_affected_model_locators). */
async function resolveAffectedModelLocators(
	names: string[],
): Promise<{ id: number; type: string; section_id: number; section_tipo: string }[]> {
	if (names.length === 0) return [];
	const rows = (await sql.unsafe(
		`SELECT section_id, string->'${TIPO_MODEL_NAME}'->0->>'value' AS model_name
		 FROM matrix_dd WHERE section_tipo = 'dd1342'`,
	)) as { section_id: number; model_name: string | null }[];
	const nameToId = new Map<string, number>();
	for (const row of rows) {
		if (row.model_name !== null) nameToId.set(row.model_name, row.section_id);
	}
	const locators: { id: number; type: string; section_id: number; section_tipo: string }[] = [];
	let id = 1;
	for (const name of names) {
		const sectionId = nameToId.get(name);
		if (sectionId === undefined) continue; // unknown model name — skipped (PHP logs)
		locators.push({
			id: id++,
			type: 'dd151',
			// WC-2026-08-10-section-id-int-canonical: the dd1342 address comes off
			// the PK column already an int; text-minting it was the old string law.
			section_id: sectionId,
			section_tipo: 'dd1342',
		});
	}
	return locators;
}
/** The dd1342 model-name component (kept local to the resolver above). */
const TIPO_MODEL_NAME = 'dd1345';

/**
 * Validate a column-keyed tool record (PHP validate_register). `basename` is the
 * directory name the tool.name must equal.
 */
export function validateRegister(record: ToolRecord, basename: string): string[] {
	const errors: string[] = [];

	if (record.data === undefined || record.relation === undefined) {
		errors.push("Invalid structure: missing 'data'/'relation' columns after conversion");
		return errors;
	}

	const name = getItems(record, TIPO.NAME)?.[0]?.value;
	if (typeof name !== 'string' || name === '') {
		errors.push(`Missing required 'name' (component ${TIPO.NAME})`);
	} else {
		if (!/^tool_[a-z0-9_]+$/.test(name)) {
			errors.push(`Invalid tool name '${name}': must match ^tool_[a-z0-9_]+$`);
		}
		if (name !== basename) {
			errors.push(`Tool name '${name}' does not match its directory name '${basename}'`);
		}
	}

	const version = getItems(record, TIPO.VERSION)?.[0]?.value;
	if (typeof version !== 'string' || version === '') {
		errors.push("Missing required 'version'");
	} else if (!/^\d+\.\d+(\.\d+)?([.-][0-9A-Za-z.]+)?$/.test(version)) {
		errors.push(`Invalid version '${version}': expected a semantic version like 1.0.0`);
	}

	const labelItems = getItems(record, TIPO.LABEL) ?? [];
	const hasLabel = labelItems.some(
		(item) => typeof (item as { value?: unknown }).value === 'string' && item.value !== '',
	);
	if (!hasLabel) errors.push("Missing required 'label': at least one language label is required");

	// JSON components: present items must carry a `value`.
	for (const tipo of MISC_TIPOS) {
		const items = getItems(record, tipo);
		if (items === null) continue;
		if (items.some((item) => item === null || typeof item !== 'object' || !('value' in item))) {
			errors.push(`Invalid component ${tipo}: items must be objects carrying a 'value'`);
		}
	}

	// Relation components: present items must be locators.
	for (const tipo of [TIPO.AFFECTED_MODELS, TIPO.ACTIVE]) {
		const items = getItems(record, tipo) as
			| { section_tipo?: string; section_id?: unknown }[]
			| null;
		if (items === null) continue;
		if (
			items.some(
				(item) =>
					item === null ||
					typeof item !== 'object' ||
					!item.section_tipo ||
					item.section_id === undefined,
			)
		) {
			errors.push(`Invalid component ${tipo}: items must be locators with section_tipo/section_id`);
		}
	}

	// Minimum-Dédalo-version gate (PHP: strip a trailing .dev before comparing).
	const minVersion = getItems(record, TIPO.DEDALO_VERSION_MIN)?.[0]?.value;
	if (typeof minVersion === 'string' && minVersion !== '') {
		if (compareVersions(minVersion, currentDedaloVersion()) > 0) {
			errors.push(`Requires Dédalo >= ${minVersion} (this install is ${currentDedaloVersion()})`);
		}
	}

	return errors;
}

/** Current engine version with any trailing .dev stripped (PHP version_compare prep). */
function currentDedaloVersion(): string {
	return formatVersion(DEDALO_DATA_VERSION);
}

/** Numeric-segment version compare: -1 / 0 / 1. */
function compareVersions(a: string, b: string): number {
	const pa = a
		.replace(/\.dev$/, '')
		.split('.')
		.map(Number);
	const pb = b
		.replace(/\.dev$/, '')
		.split('.')
		.map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da > db) return 1;
		if (da < db) return -1;
	}
	return 0;
}

/** Normalized identity of a tool (comparable across register.json and dd1324). */
interface ToolIdentity {
	name: string;
	version: string;
	label: Record<string, string>;
	active: boolean;
	showInInspector: boolean;
	showInComponent: boolean;
	requireTranslatable: boolean;
	alwaysActive: boolean;
	affectedModelIds: string[];
	affectedTipos: string[];
	properties: unknown;
}

function radioYes(record: ToolRecord, tipo: string): boolean {
	const first = (record.relation?.[tipo] as { section_id?: unknown }[] | undefined)?.[0];
	return first !== undefined && String(first.section_id) === '1';
}

/** Project a column-keyed record into its comparable identity. */
function projectIdentity(record: ToolRecord): ToolIdentity {
	const label: Record<string, string> = {};
	for (const item of getItems(record, TIPO.LABEL) ?? []) {
		const entry = item as { lang?: string; value?: string };
		if (typeof entry.lang === 'string' && typeof entry.value === 'string') {
			label[entry.lang] = entry.value;
		}
	}
	const affectedModelIds = (
		(record.relation?.[TIPO.AFFECTED_MODELS] as { section_id?: unknown }[] | undefined) ?? []
	)
		.map((locator) => String(locator.section_id))
		.sort();
	const affectedTiposRaw = getItems(record, TIPO.AFFECTED_TIPOS)?.[0]?.value;
	const affectedTipos = Array.isArray(affectedTiposRaw) ? affectedTiposRaw.map(String).sort() : [];
	return {
		name: String(getItems(record, TIPO.NAME)?.[0]?.value ?? ''),
		version: String(getItems(record, TIPO.VERSION)?.[0]?.value ?? ''),
		label,
		active: radioYes(record, TIPO.ACTIVE),
		showInInspector: radioYes(record, TIPO.SHOW_IN_INSPECTOR),
		showInComponent: radioYes(record, TIPO.SHOW_IN_COMPONENT),
		requireTranslatable: radioYes(record, TIPO.REQUIRE_TRANSLATABLE),
		alwaysActive: radioYes(record, TIPO.ALWAYS_ACTIVE),
		affectedModelIds,
		affectedTipos,
		properties: getItems(record, TIPO.PROPERTIES)?.[0]?.value ?? null,
	};
}

/** The fields where two identities differ (the dry-run diff). */
function diffIdentity(a: ToolIdentity, b: ToolIdentity): string[] {
	const diff: string[] = [];
	const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
	if (a.version !== b.version) diff.push('version');
	if (!eq(a.label, b.label)) diff.push('label');
	if (a.active !== b.active) diff.push('active');
	if (a.showInInspector !== b.showInInspector) diff.push('show_in_inspector');
	if (a.showInComponent !== b.showInComponent) diff.push('show_in_component');
	if (a.requireTranslatable !== b.requireTranslatable) diff.push('require_translatable');
	if (a.alwaysActive !== b.alwaysActive) diff.push('always_active');
	if (!eq(a.affectedModelIds, b.affectedModelIds)) diff.push('affected_models');
	if (!eq(a.affectedTipos, b.affectedTipos)) diff.push('affected_tipos');
	if (!eq(a.properties, b.properties)) diff.push('properties');
	return diff;
}

/** Read the current dd1324 registry rows, indexed by tool name. */
async function readRegistryByName(
	target: RegistryWriteTarget = DEFAULT_REGISTRY_TARGET,
): Promise<Map<string, RegistryRow>> {
	assertMatrixTable(target.table);
	const rows = (await sql.unsafe(
		`SELECT section_id, string, relation, misc FROM "${target.table}" WHERE section_tipo = $1`,
		[target.sectionTipo],
	)) as (ToolRecord & { section_id: number })[];
	const map = new Map<string, RegistryRow>();
	for (const row of rows) {
		const name = getItems(row, TIPO.NAME)?.[0]?.value;
		if (typeof name === 'string' && name !== '') {
			map.set(name, { sectionId: Number(row.section_id), record: row });
		}
	}
	return map;
}

/**
 * Force a record's dd1354 ACTIVE radio to `active`, replacing whatever
 * register.json declared. The ADMIN's on-screen choice — not the tool author's
 * file — is authoritative for a tool the install already knows (register_tools
 * widget, WC-057): without this every import re-stamped `active=1` from the
 * file and silently re-enabled tools the admin had turned off.
 *
 * Applied BEFORE validateRegister/projectIdentity, so the value flows into both
 * the dry-run diff (which then reports 'active') and the write.
 */
export function applyActiveOverride(record: ToolRecord, active: boolean): void {
	const relation = (record.relation ?? {}) as NonNullable<ToolRecord['relation']>;
	relation[TIPO.ACTIVE] = [boolLocator(active, TIPO.ACTIVE)];
	record.relation = relation;
}

/** List valid tool directories across all roots (first-root-wins). */
export function listToolDirectories(): { name: string; dir: string }[] {
	const seen = new Set<string>();
	const dirs: { name: string; dir: string }[] = [];
	for (const root of getRoots()) {
		let entries: string[];
		try {
			entries = readdirSync(root.path);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!/^tool_[a-z0-9_]+$/.test(name)) continue;
			if (seen.has(name)) continue; // first-root-wins
			if (!existsSync(resolve(root.path, name, 'register.json'))) continue;
			seen.add(name);
			dirs.push({ name, dir: resolve(root.path, name) });
		}
	}
	return dirs;
}

/**
 * The version a tool's register.json DECLARES on disk — the number the panel
 * compares against the registry row (never the registry's own copy: serving the
 * registry twice makes the mismatch the panel exists to show unrepresentable).
 * Both live formats are read; anything unreadable/unsupported (v6, bad JSON)
 * returns null, which the client renders as 'Tool version not defined'.
 */
export async function readDeclaredVersion(dir: string): Promise<string | null> {
	let raw: unknown;
	try {
		raw = await Bun.file(resolve(dir, 'register.json')).json();
	} catch {
		return null;
	}
	const format = detectFormat(raw);
	const declared =
		format === 'authoring'
			? (raw as { version?: unknown }).version
			: format === 'column'
				? getItems(raw as ToolRecord, TIPO.VERSION)?.[0]?.value
				: null;
	return typeof declared === 'string' && declared !== '' ? declared : null;
}

/** Does any client file of the tool (`<dir>/js/**`) call `tool_request`? */
async function clientCallsServer(dir: string): Promise<boolean> {
	const js = resolve(dir, 'js');
	let names: string[];
	try {
		names = await readdir(js, { recursive: true, encoding: 'utf8' });
	} catch {
		return false;
	}
	for (const name of names.filter((item) => item.endsWith('.js'))) {
		// Searched as BYTES (an ASCII name), never decoded: this is no ingest door,
		// and an implicit text decode is what ingest_encoding_tripwire refuses.
		const bytes = await Bun.file(resolve(js, name))
			.bytes()
			.catch(() => new Uint8Array());
		if (Buffer.from(bytes).includes('tool_request')) return true;
	}
	return false;
}

/**
 * The warning a tool WITHOUT a server module earns — only when its client
 * calls `tool_request` (campaign 3 C3-19): a client-only tool (a viewer, a
 * print layout, a QR code) needs no server module, and thirteen of them read
 * as thirteen failures on every clean install.
 */
export async function missingServerWarning(
	dir: string,
	hasServerModule: boolean,
): Promise<string | null> {
	if (hasServerModule || !(await clientCallsServer(dir))) return null;
	return 'no server module, yet its client calls tool_request — the call will be refused';
}

/**
 * Reconcile the tools registry. Dry-run (default) validates every tool and
 * reports whether the dd1324 registry already matches — writing nothing;
 * `dryRun: false` writes.
 *
 * `activeOverrides` (name → active) forces the dd1354 ACTIVE radio per tool,
 * outranking the register.json declaration — see applyActiveOverride. A tool
 * absent from the map keeps whatever its file declares.
 *
 * `keepStoredActive` (the update run's ancillary phase): a tool already in the
 * registry keeps the ACTIVE value STORED on its row, read under the row lock in
 * the write's own transaction (writeRegistryRecord) — the admin's choice
 * survives an update, and a toggle committed while the import runs is never
 * reverted by a value read before it (review 2026-10-30, #25).
 */
export async function importTools(
	options: {
		dryRun?: boolean;
		activeOverrides?: Record<string, boolean>;
		keepStoredActive?: boolean;
		/** The registry writer (the gate injects a failing one — review 2026-10-30 (4) #10). */
		writeRecord?: typeof writeRegistryRecord;
	} = {},
): Promise<ImportReportItem[]> {
	const writeRecord = options.writeRecord ?? writeRegistryRecord;
	const dryRun = options.dryRun ?? true;
	const activeOverrides = options.activeOverrides ?? {};
	const registry = await readRegistryByName();
	const report: ImportReportItem[] = [];

	for (const { name, dir } of listToolDirectories()) {
		const item: ImportReportItem = {
			name,
			dir,
			valid: false,
			dryRun,
			errors: [],
			warnings: [],
			inRegistry: registry.has(name),
			diff: [],
			hasServerModule: (await getLoadedTool(name)) !== undefined,
			active: false,
			version: null,
		};

		// Read + detect + convert.
		let raw: unknown;
		try {
			raw = await Bun.file(resolve(dir, 'register.json')).json();
		} catch (error) {
			item.errors.push(`Unreadable register.json: ${(error as Error).message}`);
			report.push(item);
			continue;
		}
		const format = detectFormat(raw);
		let record: ToolRecord;
		if (format === 'v6') {
			item.errors.push(
				'v6 register format (top-level `components`) is not supported by this engine',
			);
			report.push(item);
			continue;
		}
		if (format === 'invalid') {
			item.errors.push('Unrecognized register.json format');
			report.push(item);
			continue;
		}
		try {
			record = format === 'authoring' ? await convertAuthoringToV7(raw) : (raw as ToolRecord);
		} catch (error) {
			item.errors.push(`Authoring conversion failed: ${(error as Error).message}`);
			report.push(item);
			continue;
		}
		// convertAuthoringToV7 does not set the empty `data` column that
		// validateRegister requires; the column-keyed dumps already have it.
		if (record.data === undefined) record.data = {};

		// The admin's per-tool ACTIVE choice wins over the file, before both the
		// diff and the write so each sees the same value.
		const override = activeOverrides[name];
		if (override !== undefined) applyActiveOverride(record, override);
		item.active = radioYes(record, TIPO.ACTIVE);
		const declaredVersion = getItems(record, TIPO.VERSION)?.[0]?.value;
		item.version = typeof declaredVersion === 'string' ? declaredVersion : null;

		item.errors.push(...validateRegister(record, name));
		item.valid = item.errors.length === 0;
		const serverWarning = await missingServerWarning(dir, item.hasServerModule);
		if (serverWarning !== null) item.warnings.push(serverWarning);

		// Dry-run diff against the current registry row.
		if (item.valid && item.inRegistry) {
			const registryRow = registry.get(name) as RegistryRow;
			item.diff = diffIdentity(projectIdentity(record), projectIdentity(registryRow.record));
		}

		// The write (dryRun: false). PER-TOOL FAULT ISOLATION (S1-07): a failing write reports on ITS item
		// and the loop continues — a mid-loop failure no longer strands the
		// import half-applied with no per-tool account of what landed.
		if (!dryRun && item.valid) {
			try {
				await writeRecord(name, record, registry.get(name) ?? null, undefined, {
					keepStoredActive: options.keepStoredActive === true,
				});
				item.active = radioYes(record, TIPO.ACTIVE);
			} catch (error) {
				item.valid = false;
				item.writeFailed = true;
				item.errors.push(`registry write failed: ${(error as Error).message}`);
			}
		}

		report.push(item);
	}

	if (!dryRun) invalidateAllToolCaches();
	return report;
}

/** The matrix coordinates registry writes target (injectable for the scratch gate). */
export interface RegistryWriteTarget {
	table: string;
	sectionTipo: string;
}

const DEFAULT_REGISTRY_TARGET: RegistryWriteTarget = {
	table: 'matrix_tools',
	sectionTipo: TOOLS_REGISTER_SECTION_TIPO,
};

/**
 * Upsert one tool's registry record (dd1324). This writes the identity columns; the dd1353 simple-tool-object cache blob and
 * ontology renumeration are ledgered for the write-parity milestone.
 *
 * S1-07: routed through the matrix_write chokepoint. The previous raw SQL had
 * BOTH corruption modes of convention C: `$n::jsonb` binds Bun double-encodes
 * into jsonb STRING scalars (an unfindable registry row on the SHARED dd1324),
 * and an INSERT whose `$1` was bound but never referenced (42P18 — could never
 * execute, which also shielded a bare MAX+1 counter race behind it).
 * updateMatrixRecord/insertMatrixRecordWithCounter encode via json_codec, bind
 * `$n::text::jsonb`, and allocate section_id through the advisory counter.
 * Exported for the round-trip scratch gate (tools_register_write.test.ts).
 *
 * `keepStoredActive`: for a registered tool, the row is locked and its stored
 * dd1354 ACTIVE value is put on `record` (mutated: the caller reports it) before
 * the update, in ONE transaction — no value read earlier can revert a toggle
 * committed in between. A row without a stored value keeps the record's.
 */
export async function writeRegistryRecord(
	_name: string,
	record: ToolRecord,
	existing: RegistryRow | null,
	target: RegistryWriteTarget = DEFAULT_REGISTRY_TARGET,
	options: { keepStoredActive?: boolean } = {},
): Promise<void> {
	if (existing === null) {
		await insertMatrixRecordWithCounter(target.table, target.sectionTipo, columnsOf(record));
		return;
	}
	await withTransaction(async () => {
		if (options.keepStoredActive === true) await keepStoredActive(record, existing, target);
		// updateMatrixRecord is the PHP upsert-by-update: a registry row deleted
		// between read and write is recreated at the SAME coordinates.
		await updateMatrixRecord(
			target.table,
			target.sectionTipo,
			existing.sectionId,
			columnsOf(record),
		);
	});
}

function columnsOf(record: ToolRecord) {
	return {
		string: record.string ?? {},
		relation: record.relation ?? {},
		misc: record.misc ?? {},
	};
}

/** The stored ACTIVE value, read under the row lock, onto `record` (inside the write's transaction). */
async function keepStoredActive(
	record: ToolRecord,
	existing: RegistryRow,
	target: RegistryWriteTarget,
): Promise<void> {
	const stored = await readMatrixKeyForUpdate(
		target.table,
		target.sectionTipo,
		existing.sectionId,
		'relation',
		TIPO.ACTIVE,
	);
	if (stored === null || stored.length === 0) return;
	record.relation = { ...(record.relation ?? {}), [TIPO.ACTIVE]: stored } as NonNullable<
		ToolRecord['relation']
	>;
}
